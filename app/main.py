import csv
import io
import os
import secrets
from pathlib import Path
from zoneinfo import ZoneInfo

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from .categorize import all_categories, guess_category, merchant_key
from .db import Database
from .parsing import parse_amount, parse_date

STATIC_DIR = Path(__file__).with_name("static")
MONTH = r"^\d{4}-\d{2}$"
CURRENCY_SIGNS = {"KZT": "₸", "RUB": "₽", "USD": "$", "EUR": "€", "GBP": "£"}


class TransactionIn(BaseModel):
    merchant: str = Field(min_length=1, max_length=200)
    amount: str | float = Field(description='Сумма как её отдаёт Shortcuts, напр. "1 250,50 ₸"')
    currency: str | None = Field(default=None, min_length=3, max_length=3)
    card: str | None = None
    name: str | None = None
    date: str | None = Field(default=None, description="ISO-дата; если нет — текущее время")


class TransactionUpdate(BaseModel):
    category: str | None = Field(default=None, min_length=1, max_length=60)
    remember: bool = Field(default=True, description="Запомнить категорию для этого магазина")
    note: str | None = None


def format_money(cents: int, currency: str) -> str:
    whole, frac = divmod(abs(cents), 100)
    text = f"{whole:,}".replace(",", " ")
    if frac:
        text += f",{frac:02d}"
    sign = "-" if cents < 0 else ""
    return f"{sign}{text} {CURRENCY_SIGNS.get(currency, currency)}"


def to_dict(row) -> dict:
    return {
        "id": row["id"],
        "date": row["occurred_at"],
        "merchant": row["merchant"],
        "amount": row["amount_cents"] / 100,
        "currency": row["currency"],
        "category": row["category"],
        "card": row["card"],
        "name": row["name"],
        "note": row["note"],
    }


def create_app(
    db_path: str | None = None,
    api_token: str | None = None,
    timezone: str | None = None,
    default_currency: str | None = None,
) -> FastAPI:
    db = Database(db_path or os.environ.get("DB_PATH", "data/expenses.db"))
    token = api_token or os.environ.get("API_TOKEN")
    if not token:
        raise RuntimeError("Задай переменную окружения API_TOKEN (см. .env.example)")
    tz = ZoneInfo(timezone or os.environ.get("TIMEZONE", "Asia/Almaty"))
    fallback_currency = (default_currency or os.environ.get("DEFAULT_CURRENCY", "KZT")).upper()

    def require_token(authorization: str | None = Header(default=None)) -> None:
        supplied = (authorization or "").removeprefix("Bearer ").strip()
        if not secrets.compare_digest(supplied.encode(), token.encode()):
            raise HTTPException(status_code=401, detail="Неверный токен")

    app = FastAPI(title="Apple Pay Expense Tracker")
    auth = [Depends(require_token)]

    @app.get("/", include_in_schema=False)
    def dashboard():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.post("/api/transactions", dependencies=auth, status_code=201)
    def add_transaction(tx: TransactionIn):
        try:
            cents, detected = parse_amount(tx.amount)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        currency = (tx.currency or detected or fallback_currency).upper()
        merchant = tx.merchant.strip()
        category = guess_category(merchant, db.learned_rules())
        tx_id = db.insert(
            {
                "occurred_at": parse_date(tx.date, tz).isoformat(sep=" "),
                "merchant": merchant,
                "merchant_key": merchant_key(merchant),
                "amount_cents": cents,
                "currency": currency,
                "category": category,
                "card": tx.card,
                "name": tx.name,
                "raw_amount": str(tx.amount),
            }
        )
        result = to_dict(db.get(tx_id))
        # Готовый текст для уведомления в Быстрой команде
        result["message"] = f"{category}: {format_money(cents, currency)} — {merchant}"
        return result

    @app.get("/api/transactions", dependencies=auth)
    def list_transactions(
        month: str | None = Query(default=None, pattern=MONTH),
        category: str | None = None,
    ):
        return [to_dict(r) for r in db.list_transactions(month, category)]

    @app.patch("/api/transactions/{tx_id}", dependencies=auth)
    def update_transaction(tx_id: int, update: TransactionUpdate):
        if db.get(tx_id) is None:
            raise HTTPException(status_code=404, detail="Транзакция не найдена")
        if update.category:
            db.set_category(tx_id, update.category.strip(), update.remember)
        if "note" in update.model_fields_set:
            db.set_note(tx_id, update.note)
        return to_dict(db.get(tx_id))

    @app.delete("/api/transactions/{tx_id}", dependencies=auth, status_code=204)
    def delete_transaction(tx_id: int):
        if not db.delete(tx_id):
            raise HTTPException(status_code=404, detail="Транзакция не найдена")

    @app.get("/api/categories", dependencies=auth)
    def categories():
        known = all_categories()
        used = {r["category"] for r in db.list_transactions()} | set(db.learned_rules().values())
        return known + sorted(used - set(known))

    @app.get("/api/summary", dependencies=auth)
    def summary(month: str = Query(pattern=MONTH)):
        by_currency: dict[str, dict] = {}
        for row in db.summary(month):
            bucket = by_currency.setdefault(
                row["currency"], {"currency": row["currency"], "total": 0, "count": 0, "categories": [], "daily": []}
            )
            bucket["total"] += row["total_cents"] / 100
            bucket["count"] += row["count"]
            bucket["categories"].append(
                {"category": row["category"], "total": row["total_cents"] / 100, "count": row["count"]}
            )
        for row in db.daily(month):
            by_currency[row["currency"]]["daily"].append({"day": row["day"], "total": row["total_cents"] / 100})
        currencies = sorted(by_currency.values(), key=lambda b: (b["currency"] != fallback_currency, -b["total"]))
        return {"month": month, "currencies": currencies}

    @app.get("/api/export.csv", dependencies=auth)
    def export_csv(month: str | None = Query(default=None, pattern=MONTH)):
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["date", "merchant", "amount", "currency", "category", "card", "note"])
        for r in db.list_transactions(month):
            writer.writerow(
                [r["occurred_at"], r["merchant"], f"{r['amount_cents'] / 100:.2f}", r["currency"],
                 r["category"], r["card"] or "", r["note"] or ""]
            )
        filename = f"expenses-{month or 'all'}.csv"
        return StreamingResponse(
            iter(["﻿" + buf.getvalue()]),  # BOM, чтобы Excel/Numbers правильно открыл кириллицу
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    return app


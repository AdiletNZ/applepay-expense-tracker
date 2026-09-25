import pytest
from fastapi.testclient import TestClient

from app.main import create_app

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def client(tmp_path):
    app = create_app(db_path=str(tmp_path / "t.db"), api_token=TOKEN, timezone="Asia/Almaty")
    return TestClient(app)


def add(client, **kw):
    body = {"merchant": "Magnum", "amount": "5 400 ₸", "date": "2026-09-10T12:00:00+05:00", **kw}
    res = client.post("/api/transactions", json=body, headers=AUTH)
    assert res.status_code == 201, res.text
    return res.json()


def test_requires_token(client):
    assert client.post("/api/transactions", json={"merchant": "x", "amount": "1"}).status_code == 401
    assert client.get("/api/transactions", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_dashboard_is_public(client):
    assert client.get("/").status_code == 200


def test_add_transaction(client):
    tx = add(client, card="Kaspi Gold")
    assert tx["category"] == "Продукты"
    assert tx["amount"] == 5400
    assert tx["currency"] == "KZT"
    assert tx["date"] == "2026-09-10 12:00:00"
    assert tx["message"] == "Продукты: 5 400 ₸ — Magnum"


def test_default_currency_used_when_unknown(client):
    assert add(client, amount="1200")["currency"] == "KZT"


def test_bad_amount(client):
    res = client.post("/api/transactions", json={"merchant": "x", "amount": "abc"}, headers=AUTH)
    assert res.status_code == 422


def test_summary_and_filters(client):
    add(client)
    add(client, merchant="Yandex Go", amount="1 500 ₸")
    add(client, merchant="Small", amount="600 ₸")
    add(client, merchant="Starbucks", amount="$5", date="2026-09-11T09:00:00+05:00")
    add(client, merchant="Magnum", amount="100 ₸", date="2026-08-30T09:00:00+05:00")

    s = client.get("/api/summary?month=2026-09", headers=AUTH).json()
    kzt, usd = s["currencies"]
    assert kzt["currency"] == "KZT" and kzt["total"] == 7500 and kzt["count"] == 3
    assert kzt["categories"][0] == {"category": "Продукты", "total": 6000, "count": 2}
    assert usd["total"] == 5

    txs = client.get("/api/transactions?month=2026-09&category=Продукты", headers=AUTH).json()
    assert [t["merchant"] for t in txs] == ["Small", "Magnum"]


def test_recategorize_and_remember(client):
    first = add(client, merchant="ИП Ахметов")
    assert first["category"] == "Другое"
    add(client, merchant="ип  ахметов")

    res = client.patch(f"/api/transactions/{first['id']}", json={"category": "Хозтовары"}, headers=AUTH)
    assert res.json()["category"] == "Хозтовары"
    # прошлые покупки в этом магазине тоже перекатегоризованы
    assert {t["category"] for t in client.get("/api/transactions", headers=AUTH).json()} == {"Хозтовары"}
    # и будущие попадают туда же
    assert add(client, merchant="ИП АХМЕТОВ")["category"] == "Хозтовары"
    assert "Хозтовары" in client.get("/api/categories", headers=AUTH).json()


def test_recategorize_once(client):
    a = add(client)
    b = add(client)
    client.patch(f"/api/transactions/{a['id']}", json={"category": "Подарки", "remember": False}, headers=AUTH)
    assert client.get("/api/transactions", headers=AUTH).json()[0]["category"] == "Продукты"  # b
    assert add(client)["category"] == "Продукты"
    assert b["id"] != a["id"]


def test_delete_and_export(client):
    tx = add(client)
    add(client, merchant="Wolt", amount="3 200 ₸")
    assert client.delete(f"/api/transactions/{tx['id']}", headers=AUTH).status_code == 204
    assert client.delete(f"/api/transactions/{tx['id']}", headers=AUTH).status_code == 404
    csv = client.get("/api/export.csv?month=2026-09", headers=AUTH)
    assert csv.status_code == 200
    lines = csv.text.lstrip("﻿").strip().splitlines()
    assert lines[0].startswith("date,merchant")
    assert lines[1] == "2026-09-10 12:00:00,Wolt,3200.00,KZT,Доставка еды,,"

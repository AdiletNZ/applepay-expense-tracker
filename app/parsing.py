"""Разбор суммы и даты, которые присылает iOS Shortcuts.

Shortcuts отдаёт сумму строкой в формате локали телефона, например:
"1 250,50 ₸", "₸1,250.50", "$12.99", "12,99 €", "KZT 5000".
"""

import re
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal
from zoneinfo import ZoneInfo

_ISO_CODE = re.compile(r"\b([A-Z]{3})\b")
_NUMBER = re.compile(r"-?\d[\d.,]*")
_SPACES = re.compile(r"[\s   '’]")

CURRENCY_SYMBOLS = {
    "₸": "KZT",
    "тг": "KZT",
    "₽": "RUB",
    "руб": "RUB",
    "$": "USD",
    "€": "EUR",
    "£": "GBP",
    "₺": "TRY",
    "¥": "CNY",
    "₩": "KRW",
    "₴": "UAH",
    "₾": "GEL",
    "сом": "KGS",
    "сўм": "UZS",
}


def detect_currency(text: str) -> str | None:
    match = _ISO_CODE.search(text)
    if match:
        return match.group(1)
    lowered = text.lower()
    for symbol, code in CURRENCY_SYMBOLS.items():
        if symbol in lowered:
            return code
    return None


def _normalize_number(num: str) -> str:
    if "," in num and "." in num:
        decimal_sep = "," if num.rfind(",") > num.rfind(".") else "."
        thousands_sep = "." if decimal_sep == "," else ","
        return num.replace(thousands_sep, "").replace(decimal_sep, ".")
    for sep in (",", "."):
        if sep in num:
            parts = num.split(sep)
            # "12,5" / "12.99" — дробная часть; "1.250" / "1,000,000" — разделитель тысяч
            if len(parts) == 2 and 1 <= len(parts[1]) <= 2:
                return f"{parts[0]}.{parts[1]}"
            return num.replace(sep, "")
    return num


def parse_amount(value: str | int | float) -> tuple[int, str | None]:
    """Возвращает (сумма в копейках/тиынах, код валюты или None)."""
    if isinstance(value, (int, float)):
        amount, currency = Decimal(str(value)), None
    else:
        text = str(value)
        currency = detect_currency(text)
        match = _NUMBER.search(_SPACES.sub("", text))
        if not match:
            raise ValueError(f"не удалось найти сумму в {value!r}")
        amount = Decimal(_normalize_number(match.group(0).rstrip(".,")))
    cents = (amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)
    return int(cents), currency


def parse_date(value: str | None, tz: ZoneInfo) -> datetime:
    """Дата транзакции в локальном часовом поясе (без tzinfo)."""
    if value:
        try:
            dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            dt = None
        if dt is not None:
            if dt.tzinfo is not None:
                dt = dt.astimezone(tz)
            return dt.replace(tzinfo=None, microsecond=0)
    return datetime.now(tz).replace(tzinfo=None, microsecond=0)

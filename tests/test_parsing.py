from zoneinfo import ZoneInfo

import pytest

from app.parsing import parse_amount, parse_date


@pytest.mark.parametrize(
    "raw, cents, currency",
    [
        ("1 250,50 ₸", 125050, "KZT"),
        ("₸1,250.50", 125050, "KZT"),
        ("5 000 ₸", 500000, "KZT"),
        ("$12.99", 1299, "USD"),
        ("12,99 €", 1299, "EUR"),
        ("KZT 5000", 500000, "KZT"),
        ("1.250 ₽", 125000, "RUB"),
        ("1,000,000.5", 100000050, None),
        ("-3 400 ₸", -340000, "KZT"),
        (1500, 150000, None),
        (19.9, 1990, None),
    ],
)
def test_parse_amount(raw, cents, currency):
    assert parse_amount(raw) == (cents, currency)


def test_parse_amount_without_number():
    with pytest.raises(ValueError):
        parse_amount("₸")


def test_parse_date_converts_to_local_time():
    dt = parse_date("2026-09-25T10:00:00Z", ZoneInfo("Asia/Almaty"))
    assert dt.isoformat(sep=" ") == "2026-09-25 15:00:00"


def test_parse_date_falls_back_to_now_on_garbage():
    assert parse_date("вчера вечером", ZoneInfo("UTC")).year >= 2024

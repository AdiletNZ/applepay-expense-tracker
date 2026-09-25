import pytest

from app.categorize import guess_category


@pytest.mark.parametrize(
    "merchant, category",
    [
        ("MAGNUM CASH&CARRY", "Продукты"),
        ("Small #123", "Продукты"),
        ("Yandex Go", "Такси и транспорт"),
        ("YANDEX EDA", "Доставка еды"),
        ("Starbucks Dostyk", "Кафе и рестораны"),
        ("APPLE.COM/BILL", "Подписки и сервисы"),
        ("Gold Apple", "Красота"),
        ("Europharma", "Здоровье и аптеки"),
        ("Smallville Tools", "Другое"),
        ("ИП Иванов", "Другое"),
    ],
)
def test_guess_category(merchant, category):
    assert guess_category(merchant) == category


def test_learned_rule_wins():
    assert guess_category("  Magnum  ", {"magnum": "Хозтовары"}) == "Хозтовары"

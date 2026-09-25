"""Автоматическое определение категории по названию магазина.

Сначала смотрим выученные правила (когда ты вручную поменял категорию
у какого-то магазина), затем ключевые слова из categories.json.
"""

import json
import re
from functools import lru_cache
from pathlib import Path

RULES_FILE = Path(__file__).with_name("categories.json")


def merchant_key(merchant: str) -> str:
    """Нормализованное имя магазина: "MAGNUM  Cash&Carry " -> "magnum cash&carry"."""
    return " ".join(merchant.lower().split())


@lru_cache(maxsize=1)
def load_rules() -> tuple[list[tuple[str, list[re.Pattern]]], str]:
    data = json.loads(RULES_FILE.read_text(encoding="utf-8"))
    compiled = [
        (category, [re.compile(rf"(?<!\w){re.escape(kw.lower())}(?!\w)") for kw in keywords])
        for category, keywords in data["categories"].items()
    ]
    return compiled, data.get("default", "Другое")


def all_categories() -> list[str]:
    rules, default = load_rules()
    return [name for name, _ in rules] + [default]


def guess_category(merchant: str, learned: dict[str, str] | None = None) -> str:
    key = merchant_key(merchant)
    if learned and key in learned:
        return learned[key]
    rules, default = load_rules()
    for category, patterns in rules:
        if any(p.search(key) for p in patterns):
            return category
    return default

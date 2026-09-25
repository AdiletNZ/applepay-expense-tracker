import sqlite3
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at  TEXT    NOT NULL,          -- локальное время, 'YYYY-MM-DD HH:MM:SS'
    merchant     TEXT    NOT NULL,
    merchant_key TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency     TEXT    NOT NULL,
    category     TEXT    NOT NULL,
    card         TEXT,
    name         TEXT,
    raw_amount   TEXT,
    note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_occurred ON transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_tx_merchant ON transactions(merchant_key);

-- Выученные правила: магазин -> категория (после ручной правки)
CREATE TABLE IF NOT EXISTS merchant_rules (
    merchant_key TEXT PRIMARY KEY,
    category     TEXT NOT NULL
);
"""


class Database:
    def __init__(self, path: str):
        self.path = path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def learned_rules(self) -> dict[str, str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT merchant_key, category FROM merchant_rules").fetchall()
        return {r["merchant_key"]: r["category"] for r in rows}

    def insert(self, tx: dict) -> int:
        cols = ", ".join(tx)
        marks = ", ".join(f":{k}" for k in tx)
        with self.connect() as conn:
            cur = conn.execute(f"INSERT INTO transactions ({cols}) VALUES ({marks})", tx)
            return cur.lastrowid

    def get(self, tx_id: int) -> sqlite3.Row | None:
        with self.connect() as conn:
            return conn.execute("SELECT * FROM transactions WHERE id = ?", (tx_id,)).fetchone()

    def list_transactions(self, month: str | None = None, category: str | None = None) -> list[sqlite3.Row]:
        query, params = "SELECT * FROM transactions WHERE 1=1", []
        if month:
            query += " AND substr(occurred_at, 1, 7) = ?"
            params.append(month)
        if category:
            query += " AND category = ?"
            params.append(category)
        query += " ORDER BY occurred_at DESC, id DESC"
        with self.connect() as conn:
            return conn.execute(query, params).fetchall()

    def set_category(self, tx_id: int, category: str, remember: bool) -> None:
        with self.connect() as conn:
            row = conn.execute("SELECT merchant_key FROM transactions WHERE id = ?", (tx_id,)).fetchone()
            if row is None:
                return
            if remember:
                conn.execute(
                    "INSERT INTO merchant_rules (merchant_key, category) VALUES (?, ?) "
                    "ON CONFLICT(merchant_key) DO UPDATE SET category = excluded.category",
                    (row["merchant_key"], category),
                )
                conn.execute(
                    "UPDATE transactions SET category = ? WHERE merchant_key = ?",
                    (category, row["merchant_key"]),
                )
            else:
                conn.execute("UPDATE transactions SET category = ? WHERE id = ?", (category, tx_id))

    def set_note(self, tx_id: int, note: str | None) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE transactions SET note = ? WHERE id = ?", (note, tx_id))

    def delete(self, tx_id: int) -> bool:
        with self.connect() as conn:
            return conn.execute("DELETE FROM transactions WHERE id = ?", (tx_id,)).rowcount > 0

    def summary(self, month: str) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT currency, category, SUM(amount_cents) AS total_cents, COUNT(*) AS count "
                "FROM transactions WHERE substr(occurred_at, 1, 7) = ? "
                "GROUP BY currency, category ORDER BY currency, total_cents DESC",
                (month,),
            ).fetchall()

    def daily(self, month: str) -> list[sqlite3.Row]:
        with self.connect() as conn:
            return conn.execute(
                "SELECT currency, substr(occurred_at, 1, 10) AS day, SUM(amount_cents) AS total_cents "
                "FROM transactions WHERE substr(occurred_at, 1, 7) = ? "
                "GROUP BY currency, day ORDER BY day",
                (month,),
            ).fetchall()

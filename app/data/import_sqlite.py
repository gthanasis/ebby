"""Moves a single-user spending.db into Postgres as one user's data. Run once per old database."""

import sqlite3
from datetime import date
from pathlib import Path

import psycopg

from app import config
from app.data import db
from app import clock

TABLES = ["accounts", "transactions", "rules", "connections", "goals", "commitments", "assistant_messages",
          "assistant_actions", "wishlist", "habit_rules", "yearly_costs", "push_subscriptions", "meta"]


def ensure_user(email: str, admin: bool = False) -> int:
    with db.connect_system() as conn:
        row = conn.execute("""
            INSERT INTO users(email, is_admin, status, created_at) VALUES(?, ?, 'active', ?)
            ON CONFLICT(email) DO UPDATE SET is_admin = users.is_admin OR excluded.is_admin RETURNING id
        """, (email.lower(), admin, clock.now())).fetchone()
    return row["id"]


def run(path: Path, email: str, admin: bool = False) -> dict[str, int]:
    """Copies every table under the user's id and returns rows per table. Refuses if they already have data."""
    source = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    source.row_factory = sqlite3.Row
    user_id = ensure_user(email, admin)
    counts = {}
    with db.as_user(user_id), db.connect() as conn:
        if conn.execute("SELECT 1 FROM transactions LIMIT 1").fetchone():
            raise SystemExit(f"{email} already has transactions; not importing over them.")
        have = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        for table in [t for t in TABLES if t in have]:  # older databases lack the newer tables
            target = [r["column_name"] for r in conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name <> 'user_id'", (table,))]
            rows = source.execute(f"SELECT * FROM {table}").fetchall()
            columns = [c for c in rows[0].keys() if c in target] if rows else []
            for r in rows:
                conn.execute(f"INSERT INTO {table}({', '.join(columns)}) VALUES({', '.join('?' for _ in columns)})",
                             tuple(r[c] for c in columns))
            counts[table] = len(rows)
        if not db.get_meta(conn, "yearly_moved"):
            # What the previous version did on start: yearly costs became fixed costs paid every 12 months.
            today = clock.server_today()
            for y in conn.execute("SELECT * FROM yearly_costs").fetchall():
                due = date(today.year + (y["due_month"] < today.month), y["due_month"], 1)
                conn.execute("""INSERT INTO commitments(name, kind, monthly_limit, services, created_at, every_months, amount, next_date)
                                VALUES(?, 'fixed', ?, '[]', ?, 12, ?, ?)""",
                             (y["name"], round(y["yearly_amount"] / 12, 2), y["created_at"], y["yearly_amount"], due.isoformat()))
            db.set_meta(conn, "yearly_moved", True)
        settings = db.get_meta(conn, "settings") or {}
        if config.OWNER_NAMES and not settings.get("owner_names"):
            # Your names were an env var while the app had one user; now they're your own setting.
            db.set_meta(conn, "settings", {**settings, "owner_names": config.OWNER_NAMES})
        # They were already set up: skip the first-run screens.
        db.set_meta(conn, "onboarded", True)
    from app.data import credentials
    credentials.adopt_env_key(user_id)
    return counts

import contextvars
import json
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg_pool import ConnectionPool

from . import config
from .categories import categorize, merchant_name

MIGRATIONS = Path(__file__).parent / "migrations"


class NoUser(RuntimeError):
    """db.connect() was called without saying whose data it's for (see as_user)."""


# Whose data this request or job is working on. Set by the auth middleware and by as_user;
# context variables follow sync endpoints into the threadpool, and db.thread() into new threads.
_user: ContextVar[int | None] = ContextVar("user", default=None)
_pool: ConnectionPool | None = None


class Row(dict):
    """A row read by name (row["amount"]) or by position (row[0]), as sqlite3.Row allowed."""

    def __getitem__(self, key):
        return list(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def _row_factory(cursor):
    names = [c.name for c in cursor.description or []]
    return lambda values: Row(zip(names, values))


def _sql(sql: str) -> str:
    """The app's queries use sqlite's ? placeholders; psycopg wants %s and a literal % doubled."""
    return sql.replace("%", "%%").replace("?", "%s")


class Conn:
    """A transaction on Postgres that reads like the sqlite3 connection the code was written against."""

    def __init__(self, pg: psycopg.Connection):
        self.pg = pg

    def execute(self, sql: str, params=()):
        return self.pg.cursor(row_factory=_row_factory).execute(_sql(sql), params)


def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        if not config.DATABASE_URL:
            raise RuntimeError("DATABASE_URL is not set")
        _pool = ConnectionPool(config.DATABASE_URL, min_size=1, max_size=10, open=True)
    return _pool


@contextmanager
def connect():
    """One transaction acting for the current user. Postgres' row-level security then shows it only
    that user's rows, so no query has to remember to filter. Without a user it refuses outright."""
    user_id = _user.get()
    if user_id is None:
        raise NoUser("db.connect() with no user; wrap the work in db.as_user()")
    with pool().connection() as pg:
        # true: for this transaction only, so the pooled connection never carries it into the next one.
        pg.execute("SELECT set_config('app.user_id', %s, true)", (str(user_id),))
        yield Conn(pg)


@contextmanager
def connect_system():
    """A transaction acting for nobody: sees users and sessions, and none of anyone's own rows."""
    with pool().connection() as pg:
        yield Conn(pg)


# Advisory lock namespaces: several pods share the database, so "only one at a time" has to live there.
LOCK_SCHEDULER = 1  # the background round, with 0
LOCK_SYNC = 2       # a person's bank sync, with their user id


@contextmanager
def advisory_lock(space: int, key: int):
    """Yields True if this process now holds the lock (space, key), False if another one does. Held on a
    connection of its own until the block ends; if the process dies, Postgres drops it with the connection."""
    with pool().connection() as pg:
        pg.autocommit = True  # a session lock, outside any transaction the block's own queries open
        got = pg.execute("SELECT pg_try_advisory_lock(%s, %s)", (space, key)).fetchone()[0]
        try:
            yield got
        finally:
            if got:
                pg.execute("SELECT pg_advisory_unlock(%s, %s)", (space, key))
            pg.autocommit = False


def is_locked(space: int, key: int) -> bool:
    """Whether any process holds (space, key) right now."""
    with pool().connection() as pg:
        return pg.execute("""SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
                             AND classid = %s AND objid = %s AND objsubid = 2)""", (space, key)).fetchone()[0]


@contextmanager
def as_user(user_id: int):
    token = _user.set(user_id)
    try:
        yield
    finally:
        _user.reset(token)


def current_user() -> int | None:
    return _user.get()


def thread(target, *args) -> threading.Thread:
    """Starts a daemon thread that keeps acting for the current user (threads don't inherit context)."""
    t = threading.Thread(target=contextvars.copy_context().run, args=(target, *args), daemon=True)
    t.start()
    return t


def init():
    """Applies pending migrations as the owner role, and makes sure the app's own role exists.
    The app connects as that role, which owns nothing, so row-level security always applies to it."""
    app = conninfo_to_dict(config.DATABASE_URL)
    with psycopg.connect(config.DATABASE_OWNER_URL or config.DATABASE_URL, autocommit=True) as pg:
        pg.execute("SELECT pg_advisory_lock(7351)")  # one migrator at a time
        if not pg.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (app["user"],)).fetchone():
            pg.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(sql.Identifier(app["user"]), sql.Literal(app["password"])))
        pg.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
        done = {r[0] for r in pg.execute("SELECT version FROM schema_migrations")}
        for path in sorted(MIGRATIONS.glob("*.sql")):
            version = int(path.name.split("_")[0])
            if version in done:
                continue
            with pg.transaction():
                pg.execute(path.read_text())
                pg.execute("INSERT INTO schema_migrations(version) VALUES (%s)", (version,))
        role = sql.Identifier(app["user"])
        pg.execute(sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(role))
        pg.execute(sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {}").format(role))
        pg.execute(sql.SQL("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {}").format(role))
        pg.execute(sql.SQL("REVOKE ALL ON schema_migrations FROM {}").format(role))
        pg.execute("SELECT pg_advisory_unlock(7351)")


def admin_id() -> int | None:
    with connect_system() as conn:
        row = conn.execute("SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1").fetchone()
    return row["id"] if row else None


def active_users() -> list[int]:
    with connect_system() as conn:
        return [r["id"] for r in conn.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id")]


def user_by_email(email: str) -> dict | None:
    with connect_system() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.lower(),)).fetchone()
    return dict(row) if row else None


def connections(conn) -> list[dict]:
    rows = []
    for r in conn.execute("SELECT * FROM connections ORDER BY bank"):
        row = dict(r)
        row["last_error"] = json.loads(row["last_error"]) if row["last_error"] else None
        rows.append(row)
    return rows


def update_connection(conn, bank: str, **fields):
    if "last_error" in fields and fields["last_error"] is not None:
        fields["last_error"] = json.dumps(fields["last_error"])
    conn.execute("INSERT INTO connections(bank) VALUES(?) ON CONFLICT(user_id, bank) DO NOTHING", (bank,))
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE connections SET {sets} WHERE bank = ?", (*fields.values(), bank))


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return json.loads(row["value"]) if row else default


def set_meta(conn, key, value):
    conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
                 (key, json.dumps(value)))


def upsert_account(conn, acc: dict, bank: str):
    ident = acc.get("account_id") or {}
    iban = ident.get("iban") or ""
    # Alpha cards come as OTHR/CARD; Revolut pockets are SVGS and behave like accounts.
    is_card = acc.get("cash_account_type") not in ("CACC", "SVGS", "TRAN")
    # Alpha names accounts in `product`, Revolut pockets in `details`; Revolut's `name` is just the holder.
    name = acc.get("product") or acc.get("details") or f"{bank} {acc.get('currency') or ''}".strip()
    conn.execute("""
        INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET uid = excluded.uid, name = excluded.name, is_card = excluded.is_card,
          last4 = COALESCE(excluded.last4, accounts.last4), bank = excluded.bank
    """, (acc["identification_hash"], acc["uid"], name.strip(), int(is_card), iban[-4:] or None, bank))


def tx_key(tx: dict) -> str:
    return tx.get("entry_reference") or json.dumps(
        [tx.get("booking_date"), tx.get("transaction_amount"), tx.get("remittance_information")], sort_keys=True)


def owner_names(conn) -> list[str]:
    return (get_meta(conn, "settings") or {}).get("owner_names") or []


def _row(account: str, is_card: bool, tx: dict, rules: dict, mcc_hint: str | None = None, owners=()):
    amount = tx.get("transaction_amount") or {}
    outgoing = tx.get("credit_debit_indicator") == "DBIT"
    value = float(amount.get("amount") or 0)
    description = " ".join(tx.get("remittance_information") or [])
    party = (tx.get("creditor") if outgoing else tx.get("debtor")) or {}
    merchant = merchant_name(party.get("name") or description)
    if is_card and merchant in {"Αγορά", "Επιστροφή"}:
        merchant = ""  # card rows have no merchant name, only a category code
    # Account rows of debit-card purchases carry no code; dedupe() copies the card row's onto them.
    mcc = tx.get("merchant_category_code") or mcc_hint
    tx_id = f"{account}:{tx_key(tx)}"
    # Rules are keyed by merchant, or by "tx:<id>" for a single row (card rows have no merchant).
    category = rules.get(f"tx:{tx_id}") or (merchant and rules.get(merchant)) or categorize(description, mcc, outgoing, is_card, owners)
    return (
        tx_id, account,
        tx.get("booking_date") or tx.get("transaction_date") or tx.get("value_date"),
        -value if outgoing else value, amount.get("currency") or "EUR", tx.get("status") or "BOOK",
        description, merchant, mcc, category, json.dumps(tx, ensure_ascii=False),
    )


def save_window(conn, account: str, is_card: bool, start: str, end: str, transactions: list) -> int:
    """Stores one fetched date window. Pending rows in it are replaced: they get new ids once booked."""
    rules = {r["merchant"]: r["category"] for r in conn.execute("SELECT merchant, category FROM rules")}
    owners = owner_names(conn)
    conn.execute("DELETE FROM transactions WHERE account = ? AND status = 'PDNG' AND date BETWEEN ? AND ?",
                 (account, start, end))
    changed = 0
    for tx in transactions:
        row = _row(account, is_card, tx, rules, owners=owners)
        if row[2] is None:
            continue
        changed += conn.execute("""
            INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, id) DO UPDATE SET amount = excluded.amount, status = excluded.status,
              date = CASE WHEN EXISTS (SELECT 1 FROM transactions c WHERE c.duplicate_of = transactions.id
                                       AND c.user_id = transactions.user_id) THEN transactions.date ELSE excluded.date END,
              raw = excluded.raw
        """, row).rowcount
    return changed


def recategorize(conn):
    """Re-runs the rules over every stored row (after changing rules or categories.py)."""
    rules = {r["merchant"]: r["category"] for r in conn.execute("SELECT merchant, category FROM rules")}
    cards = {r["id"]: bool(r["is_card"]) for r in conn.execute("SELECT id, is_card FROM accounts")}
    owners = owner_names(conn)
    for r in conn.execute("SELECT id, account, raw, mcc FROM transactions").fetchall():
        row = _row(r["account"], cards.get(r["account"], False), json.loads(r["raw"]), rules, r["mcc"], owners)
        conn.execute("UPDATE transactions SET merchant = ?, category = ? WHERE id = ?", (row[7], row[9], r["id"]))
    from . import insights  # late: insights imports db
    insights.assign_commitments(conn)


# A debit card's purchase shows up twice: on the card (category code, no name) and a few days later
# on its current account (merchant name). Credit cards don't: their repayment is one transfer.
DEBIT_MATCH_SHARE = 0.6


def dedupe(conn) -> int:
    """Pairs debit-card rows with their current-account copies and marks the card row as the
    duplicate. A card counts as debit when most of its purchases have such a copy. Returns pairs made."""
    conn.execute("""UPDATE transactions SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL
                    AND duplicate_of NOT IN (SELECT id FROM transactions)""")
    rules = {r["merchant"]: r["category"] for r in conn.execute("SELECT merchant, category FROM rules")}
    made = 0
    for card in conn.execute("SELECT id, bank FROM accounts WHERE is_card = 1").fetchall():
        rows = conn.execute("SELECT id, date, amount, mcc FROM transactions WHERE account = ? AND amount < 0 ORDER BY date",
                            (card["id"],)).fetchall()
        if not rows:
            continue
        taken = {r[0] for r in conn.execute("SELECT duplicate_of FROM transactions WHERE duplicate_of IS NOT NULL")}
        pairs = []
        for r in rows:
            for m in conn.execute("""
                SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account
                WHERE a.is_card = 0 AND a.bank = ? AND t.amount = ? AND t.category NOT IN ('transfer', 'investments', 'card_payment', 'income')
                  AND t.date::date - ?::date BETWEEN -1 AND 6
                ORDER BY abs(t.date::date - ?::date)
            """, (card["bank"], r["amount"], r["date"], r["date"])):
                if m["id"] not in taken:
                    taken.add(m["id"])
                    pairs.append((r, m["id"]))
                    break
        if len(pairs) < len(rows) * DEBIT_MATCH_SHARE:
            continue  # a credit card, or too few matches to be sure
        for r, account_row in pairs:
            made += conn.execute("UPDATE transactions SET duplicate_of = ? WHERE id = ? AND duplicate_of IS NULL",
                                 (account_row, r["id"])).rowcount
            if r["mcc"]:
                conn.execute("UPDATE transactions SET mcc = ? WHERE id = ? AND (mcc IS NULL OR mcc = '')", (r["mcc"], account_row))
    # The account books a purchase days after you made it; the card row has the day you paid.
    conn.execute("""UPDATE transactions t SET date = c.date FROM transactions c
                    WHERE c.duplicate_of = t.id AND c.user_id = t.user_id AND t.date <> c.date""")
    if made:
        recategorize(conn)
    return made

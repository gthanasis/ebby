"""Tests run against a real Postgres, because row-level security is what they check.

Uses TEST_DATABASE_OWNER_URL (default: the local docker container from .env.example) to create a
fresh bank_sync_test database per run.
"""

import base64
import os

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

OWNER = os.environ.get("TEST_DATABASE_OWNER_URL", "postgresql://bank_sync_owner:owner@localhost:55432/postgres")
TEST_DB = "bank_sync_test"
# Set before app.config is imported; its .env loader only fills what's missing.
os.environ["DATABASE_OWNER_URL"] = make_conninfo(OWNER, dbname=TEST_DB)
os.environ["DATABASE_URL"] = make_conninfo(OWNER, dbname=TEST_DB, user="bank_sync_test_app", password="test")
os.environ["PUBLIC_URL"] = "http://localhost:8000"
os.environ["APP_PASSWORD"] = ""
os.environ["ADMIN_EMAIL"] = ""
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["GOOGLE_CLIENT_ID"] = ""
os.environ["CREDENTIALS_KEY"] = base64.b64encode(b"k" * 32).decode()


@pytest.fixture(scope="session", autouse=True)
def database():
    with psycopg.connect(OWNER, autocommit=True) as pg:
        pg.execute(f"DROP DATABASE IF EXISTS {TEST_DB} WITH (FORCE)")
        pg.execute(f"CREATE DATABASE {TEST_DB}")
    from app import db
    db.init()
    yield
    if db._pool:
        db._pool.close()


@pytest.fixture(scope="session")
def users(database):
    """Two people with data that's easy to spot: anything of A's showing up for B is a leak."""
    from app import db
    from app.import_sqlite import ensure_user
    a, b = ensure_user("a@example.com", admin=True), ensure_user("b@example.com")
    for user, tag in ((a, "AAA"), (b, "BBB")):
        with db.as_user(user), db.connect() as conn:
            conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES(?, ?, ?, 0, 'Alpha Bank')",
                         (f"acc-{tag}", f"uid-{tag}", f"Account {tag}"))
            for i, (merchant, category, amount) in enumerate([(f"Shop {tag}", "groceries", -42.17), (f"Wolt {tag}", "delivery", -18.5),
                                                              (f"Salary {tag}", "income", 1500)]):
                conn.execute("""INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, category, raw)
                                VALUES(?, ?, to_char(now() - make_interval(days => ?), 'YYYY-MM-DD'), ?, 'EUR', 'BOOK', ?, ?, ?, '{}')""",
                             (f"acc-{tag}:{i}", f"acc-{tag}", i + 1, amount, f"{merchant} purchase", merchant, category))
            conn.execute("INSERT INTO rules(merchant, category) VALUES(?, 'delivery')", (f"Wolt {tag}",))
            conn.execute("INSERT INTO goals(name, price, target_date, created_at) VALUES(?, 900, '2027-06-01', '2026-10-01')", (f"Goal {tag}",))
            conn.execute("INSERT INTO commitments(name, monthly_limit, created_at) VALUES(?, 50, '2026-10-01')", (f"Commitment {tag}",))
            conn.execute("INSERT INTO connections(bank, session_id) VALUES('Alpha Bank', ?)", (f"session-{tag}",))
            db.set_meta(conn, "settings", {"owner_names": [f"Owner {tag}"]})
    return {"a": a, "b": b}

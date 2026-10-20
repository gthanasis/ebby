"""Getting transactions out of Enable Banking and into ebby, against a fake that behaves like the real banks."""

from datetime import date, timedelta

import pytest

from app.data import db
from app.integrations import enable_banking
from app.integrations.enable_banking import Client, EnableBankingError
from app.jobs import sync


def tx(day: str, amount: float, text: str, out=True, ref=None, **extra) -> dict:
    return {"entry_reference": ref or f"{day}-{text}-{amount}", "booking_date": day, "status": "BOOK",
            "credit_debit_indicator": "DBIT" if out else "CRDT",
            "transaction_amount": {"amount": str(amount), "currency": "EUR"}, "remittance_information": [text], **extra}


class FakeBank(Client):
    """Answers /transactions like Alpha Bank: only the newest `cap` rows of a window, with no way to ask for
    the rest, and pages of `page` rows otherwise."""

    def __init__(self, rows, cap=None, page=None, fail=None):
        super().__init__("app", b"")
        self.rows, self.cap, self.page, self.fail, self.calls = rows, cap, page, fail, []

    def call(self, method, path, psu=None, **kwargs):
        if self.fail:
            raise self.fail
        if path.endswith("/balances"):
            return {"balances": [{"balance_type": "CLBD", "balance_amount": {"amount": "10.00"}},
                                 {"balance_type": "ITAV", "balance_amount": {"amount": "12.50"}}]}
        p = kwargs["params"]
        self.calls.append((p["date_from"], p["date_to"], p.get("continuation_key")))
        rows = sorted((r for r in self.rows if p["date_from"] <= r["booking_date"] <= p["date_to"]),
                      key=lambda r: r["booking_date"], reverse=True)
        if self.cap:
            return {"transactions": rows[:self.cap]}
        start = int(p.get("continuation_key") or 0)
        more = start + self.page < len(rows) if self.page else False
        end = start + self.page if self.page else None
        return {"transactions": rows[start:end], "continuation_key": str(start + self.page) if more else None}


def days(n: int, start="2026-10-01"):
    first = date.fromisoformat(start)
    return [(first + timedelta(days=i)).isoformat() for i in range(n)]


def test_a_window_the_bank_truncates_is_split_until_nothing_is_lost():
    rows = [tx(d, 5 + i, f"Shop {i}") for d in days(14) for i in range(6)]  # 84 rows over two weeks
    bank = FakeBank(rows, cap=enable_banking.SUSPECT_FULL)
    got = bank._window("uid", date(2026, 10, 1), date(2026, 10, 14))
    assert {r["entry_reference"] for r in got} == {r["entry_reference"] for r in rows}
    assert len(bank.calls) > 1  # it had to split


def test_pages_are_followed_to_the_end():
    rows = [tx(d, 3, "Kiosk") for d in days(10)]
    bank = FakeBank(rows, page=4)
    assert len(bank._window("uid", date(2026, 10, 1), date(2026, 10, 10))) == 10
    assert [c[2] for c in bank.calls] == [None, "4", "8"]


def test_history_is_fetched_in_windows_newest_first_without_gaps(monkeypatch):
    monkeypatch.setenv("EBBY_NOW", "2026-10-20T12:00:00+00:00")
    windows = [(s, e) for s, e, _ in FakeBank([]).transactions("uid", 40)]
    assert windows[0][1] == date(2026, 10, 20)
    assert windows[-1][0] == date(2026, 9, 10)  # 40 days back
    for (_, older_end), (newer_start, _) in zip(windows[1:], windows):
        assert older_end == newer_start - timedelta(days=1)
    assert all((e - s).days < enable_banking.WINDOW_DAYS for s, e in windows)


def test_a_bank_row_becomes_a_transaction():
    rules = {"Wolt": "eating_out"}
    out = db._row("acc", False, tx("2026-10-02", 18.5, "WΟLΤ ΔΕΛΙΒΕΡΥ", creditor={"name": "WΟLΤ"}), rules)
    assert out[2:8] == ("2026-10-02", -18.5, "EUR", "BOOK", "WΟLΤ ΔΕΛΙΒΕΡΥ", "Wolt")  # Greek look-alikes read as Latin
    assert out[9] == "eating_out"  # their rule for the payee beats the built-in one

    pay = db._row("acc", False, tx("2026-10-25", 2400, "ΜΙΣΘΟΔΟΣΙΑ", out=False), {})
    assert pay[3] == 2400 and pay[9] == "income"

    card = db._row("card", True, tx("2026-10-03", 9.9, "Αγορά", merchant_category_code="5812"), {})
    assert card[7] == "" and card[8] == "5812" and card[9] == "eating_out"  # no name on card rows, only the code
    card_id = card[0]
    assert db._row("card", True, tx("2026-10-03", 9.9, "Αγορά", merchant_category_code="5812"),
                   {f"tx:{card_id}": "leisure"})[9] == "leisure"  # a rule for that one payment wins over all

    pending = db._row("acc", False, {**tx("2026-10-04", 1, "x"), "booking_date": None, "transaction_date": "2026-10-03"}, {})
    assert pending[2] == "2026-10-03"


BANK = "Test Bank"


@pytest.fixture
def connected(users, monkeypatch):
    """User B with one account at a bank of its own (a sync covers every account at the bank), connected."""
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)
    with db.as_user(users["b"]), db.connect() as conn:
        conn.execute(f"INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('acc-sync', 'uid-sync', 'Current', 0, '{BANK}')")
        db.update_connection(conn, BANK, session_id="session-sync", last_error=None)
    yield users["b"]
    with db.as_user(users["b"]), db.connect() as conn:
        conn.execute("DELETE FROM transactions WHERE account = 'acc-sync'")
        conn.execute("DELETE FROM accounts WHERE id = 'acc-sync'")
        conn.execute("DELETE FROM connections WHERE bank = ?", (BANK,))


def _connection(conn):
    return next(c for c in db.connections(conn) if c["bank"] == BANK)


def test_a_sync_stores_rows_once_and_the_balance(connected, monkeypatch):
    monkeypatch.setenv("EBBY_NOW", "2026-10-20T12:00:00+00:00")
    bank = FakeBank([tx("2026-10-15", 42.17, "ΣΚΛΑΒΕΝΙΤΗΣ"), tx("2026-10-16", 6.2, "Coffee Island")])
    with db.as_user(connected):
        with db.connect() as conn:
            row = _connection(conn)
        assert sync._sync_bank(bank, row)
        assert sync._sync_bank(bank, row)  # again: nothing doubles
        with db.connect() as conn:
            stored = conn.execute("SELECT amount, category FROM transactions WHERE account = 'acc-sync' ORDER BY date").fetchall()
            account = conn.execute("SELECT balance FROM accounts WHERE id = 'acc-sync'").fetchone()
            after = _connection(conn)
    assert [(r["amount"], r["category"]) for r in stored] == [(-42.17, "groceries"), (-6.2, "eating_out")]
    assert account["balance"] == 12.5  # interim available beats closing booked
    assert after["last_sync"] and after["last_error"] is None


def test_an_expired_session_asks_for_reconnecting(connected):
    bank = FakeBank([], fail=EnableBankingError(401, "EXPIRED_SESSION", "Session expired"))
    with db.as_user(connected):
        with db.connect() as conn:
            assert not sync._sync_bank(bank, _connection(conn))
            error = _connection(conn)["last_error"]
    assert error["reconnect"] is True and error["code"] == "EXPIRED_SESSION"


def test_a_network_hiccup_doesnt(connected):
    bank = FakeBank([], fail=ConnectionError("reset by peer"))
    with db.as_user(connected):
        with db.connect() as conn:
            assert not sync._sync_bank(bank, _connection(conn))
            error = _connection(conn)["last_error"]
    assert error["reconnect"] is False and error["code"] == "ConnectionError"

"""A debit-card purchase counts on the day you paid, not the day the current account books it."""

import json

from app.data import db
from app.data.import_sqlite import ensure_user


def _tx(entry, amount, booked, value, text, mcc=None):
    return {"entry_reference": entry, "merchant_category_code": mcc, "credit_debit_indicator": "DBIT", "status": "BOOK",
            "transaction_amount": {"currency": "EUR", "amount": str(amount)}, "booking_date": booked, "value_date": value,
            "remittance_information": [text]}


def test_paired_purchase_keeps_the_card_date_across_syncs():
    user = ensure_user("dedupe@example.com")
    card = [_tx("c1", 66.91, "2026-10-15", "2026-10-17", "Αγορά", "5411"), _tx("c2", 23.1, "2026-10-17", "2026-10-18", "Αγορά", "5812")]
    account = [_tx("a1", 66.91, "2026-10-19", "2026-10-15", "AB VASILOPOULOS S.A."), _tx("a2", 23.1, "2026-10-19", "2026-10-17", "WOLT")]
    with db.as_user(user), db.connect() as conn:
        conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('card', 'u1', 'Enter Visa', 1, 'Alpha Bank')")
        conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('current', 'u2', 'Savings', 0, 'Alpha Bank')")
        for _ in range(2):  # the second sync must not move them back to the booking date
            db.save_window(conn, "card", True, "2026-10-01", "2026-10-19", card)
            db.save_window(conn, "current", False, "2026-10-01", "2026-10-19", account)
            db.dedupe(conn)
            counted = conn.execute("""SELECT date, amount FROM transactions WHERE duplicate_of IS NULL AND amount < 0
                                      ORDER BY date""").fetchall()
            assert [(r["date"], r["amount"]) for r in counted] == [("2026-10-15", -66.91), ("2026-10-17", -23.1)]
        assert json.loads(conn.execute("SELECT raw FROM transactions WHERE id LIKE '%a1'").fetchone()["raw"])["booking_date"] == "2026-10-19"

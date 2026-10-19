"""A made-up person's money, for screenshots, the demo video and trying the app without a bank.

`bank-sync demo-seed` fills one user with about six months of Greek spending, shaped like what Enable
Banking returns, and runs it through the same steps a real sync does (categories, debit-card pairing,
the plan). Dates are relative to today, so the demo always looks current. Nothing here is anyone's
real data. It only ever touches the demo user's own rows.
"""

import json
import random
from datetime import date, datetime, timedelta, timezone

from . import db, habits, insights

EMAIL = "demo@spending.local"
DAYS = 185
CURRENT, CARD, REVOLUT = "demo-alpha-current", "demo-alpha-card", "demo-revolut"

# (description on the current account, low €, high €, visits a week)
CURRENT_SPENDS = [
    ("SKLAVENITIS", 18, 75, 1.0), ("AB VASILOPOULOS", 10, 45, 0.6), ("LIDL HELLAS", 15, 50, 0.4),
    ("WOLT", 11, 32, 2.2), ("EFOOD", 12, 28, 0.6), ("FOURNOS GEORGIOU", 3, 9, 1.5),
    ("SHELL", 35, 55, 0.35), ("UBER", 6, 18, 0.7), ("OASA ATHENS METRO", 2, 5, 1.2),
    ("PHARMACY MARKOU", 6, 38, 0.25), ("SKROUTZ", 15, 140, 0.3), ("ZARA", 25, 90, 0.12),
    ("IKEA", 20, 180, 0.06), ("VILLAGE CINEMAS", 9, 22, 0.2), ("HAIR STUDIO", 18, 30, 0.12),
]
# Card purchases come with a merchant type only, as Alpha Bank's do: (MCC, low, high, a week)
CARD_SPENDS = [("5813", 3, 12, 3.0), ("5812", 14, 42, 0.7), ("5814", 6, 14, 0.8), ("5411", 8, 40, 0.5)]
MONTHLY = [  # (day of month, description, amount)
    (1, "ΕΝΟΙΚΙΟ ΔΙΑΜΕΡΙΣΜΑΤΟΣ", 650), (3, "COSMOTE", 42), (6, "ΔΕΗ", 61), (9, "NETFLIX.COM", 13.99),
    (9, "SPOTIFY", 10.99), (12, "ICLOUD APPLE.COM", 2.99), (14, "CLAUDE.AI SUBSCRIPTION", 21.6),
    (15, "GYM FITNESS ATHLETIC", 45), (20, "EYDAP", 19), (22, "VODAFONE MOBILE", 18),
]
REVOLUT_SPENDS = [("Coffee Island", 3, 6, 1.2), ("FreeNow", 5, 14, 0.4), ("Amazon", 12, 70, 0.2)]


class _Bank:
    def __init__(self, today: date):
        self.today, self.rng, self.rows, self.n = today, random.Random(2026), {CURRENT: [], CARD: [], REVOLUT: []}, 0

    def add(self, account: str, day: date, amount: float, description: str, party: str | None = None, mcc: str | None = None):
        if day > self.today:
            return
        self.n += 1
        out = amount < 0
        self.rows[account].append({
            "entry_reference": f"demo-{self.n}", "booking_date": day.isoformat(), "status": "BOOK",
            "transaction_amount": {"amount": f"{abs(amount):.2f}", "currency": "EUR"},
            "credit_debit_indicator": "DBIT" if out else "CRDT",
            "remittance_information": [description],
            ("creditor" if out else "debtor"): {"name": party or description},
            **({"merchant_category_code": mcc} if mcc else {}),
        })

    def spend(self, rate_a_week: float) -> int:
        """How many times this happens today, for something done `rate_a_week` times a week."""
        return sum(self.rng.random() < rate_a_week / 7 for _ in range(1 + int(rate_a_week // 7)))

    def euros(self, low: float, high: float) -> float:
        return round(self.rng.uniform(low, high), 2)


def _history(today: date) -> dict[str, list]:
    b = _Bank(today)
    first = today - timedelta(days=DAYS)
    for i in range(DAYS + 1):
        day = first + timedelta(days=i)
        weekend = day.weekday() >= 5
        for desc, low, high, rate in CURRENT_SPENDS:
            rate *= 1.5 if weekend and desc in ("WOLT", "EFOOD", "VILLAGE CINEMAS") else 1
            for _ in range(b.spend(rate)):
                b.add(CURRENT, day, -b.euros(low, high), f"ΑΓΟΡΑ ΜΕ ΚΑΡΤΑ {desc}", desc)
        for mcc, low, high, rate in CARD_SPENDS:
            for _ in range(b.spend(rate * (1.4 if weekend else 1))):
                b.add(CARD, day, -b.euros(low, high), "Αγορά", "Αγορά", mcc)
        for name, low, high, rate in REVOLUT_SPENDS:
            for _ in range(b.spend(rate)):
                b.add(REVOLUT, day, -b.euros(low, high), name.upper(), name)
        for dom, desc, amount in MONTHLY:
            if day.day == dom:
                b.add(CURRENT, day, -amount, desc)
        if day.day == 25:
            b.add(CURRENT, day, 2400, "ΜΙΣΘΟΔΟΣΙΑ ΕΡΓΟΔΟΤΗ", "ΕΡΓΟΔΟΤΗΣ ΑΕ")  # a made-up employer
        if day.day == 27:
            b.add(CURRENT, day, -150, "ΜΕΤΑΦΟΡΑ ΣΕ REVOLUT")  # top-up: an own transfer, not spending
            b.add(REVOLUT, day, 150, "Top-Up by card", "Top-Up")
        if day.day == 5:  # the card bill, paid from the current account
            b.add(CURRENT, day, -round(b.rng.uniform(420, 560), 2), "ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ VISA")
        if day.day in (8, 21) and b.rng.random() < 0.7:
            b.add(CURRENT, day, -b.rng.choice([40, 50, 60]), "ΑΝΑΛΗΨΗ ATM")
        if day.day == 17 and b.rng.random() < 0.5:
            b.add(REVOLUT, day, -b.rng.choice([15, 20, 25]), "To Nikos Alexiou", "Nikos Alexiou")
    trip = today - timedelta(days=58)
    b.add(CURRENT, trip - timedelta(days=30), -186, "AEGEAN AIRLINES", "AEGEAN AIRLINES")
    b.add(CURRENT, trip, -312, "BOOKING.COM HOTEL", "BOOKING.COM")
    return b.rows


def seed(email: str = EMAIL) -> dict:
    """Replaces the demo user's data with a fresh made-up history. Returns counts."""
    from .import_sqlite import ensure_user
    user_id = ensure_user(email, admin=True)
    today = insights.local_today()
    rows = _history(today)
    with db.as_user(user_id), db.connect() as conn:
        for table in ("transactions", "accounts", "rules", "connections", "goals", "commitments", "habit_rules",
                      "wishlist", "assistant_messages", "assistant_actions", "meta"):
            conn.execute(f"DELETE FROM {table}")  # row-level security: only the demo user's own rows
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for acc_id, bank, name, is_card, last4, balance in [
                (CURRENT, "Alpha Bank", "Alpha Μισθοδοσία", 0, "4417", 1842.37), (CARD, "Alpha Bank", "Alpha Bank Bonus Visa", 1, "9021", -386.12),
                (REVOLUT, "Revolut", "Revolut EUR", 0, None, 96.55)]:
            conn.execute("""INSERT INTO accounts(id, uid, name, is_card, last4, bank, balance, balance_at, synced_at)
                            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)""", (acc_id, acc_id, name, is_card, last4, bank, balance, now, now))
        db.set_meta(conn, "settings", {"owner_names": ["Maria Papadopoulou"]})
        for acc_id, txs in rows.items():
            dates = sorted(t["booking_date"] for t in txs)
            db.save_window(conn, acc_id, acc_id == CARD, dates[0], dates[-1], txs)
        db.dedupe(conn)
        insights.assign_commitments(conn)
        insights.autofill(conn)
        valid = (datetime.now(timezone.utc) + timedelta(days=171)).isoformat(timespec="seconds")
        for bank in ("Alpha Bank", "Revolut"):
            db.update_connection(conn, bank, session_id=f"demo-{bank}", valid_until=valid, last_sync=now)
        conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at, kind) VALUES(?, ?, ?, ?, ?, ?)",
                     ("Lisbon in March", 900, 240, date(today.year + (today.month > 3), 3, 15).isoformat(), now, "buy"))
        conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at, kind) VALUES(?, ?, ?, ?, ?, ?)",
                     ("Safety net", 4500, 1950, (today + timedelta(days=300)).isoformat(), now, "save"))
        conn.execute("""INSERT INTO commitments(name, kind, monthly_limit, note, services, created_at, every_months, amount, next_date)
                        VALUES('Gym', 'chosen', 45, 'Three times a week, worth it', '[]', ?, 1, 45, NULL)""", (now,))
        habits.add_rule(conn, "fewer", "delivery", 2)
        db.set_meta(conn, "weekly_read", {
            "headline": "Weekend delivery is most of the overspend",
            "findings": [
                {"title": "Weekend Wolt orders", "detail": "9 orders across two weekends", "amount": 184, "unit": "month", "category": "delivery"},
                {"title": "Coffee most mornings", "detail": "21 card coffees this month", "amount": 126, "unit": "month", "category": "coffee_bars"},
                {"title": "Skroutz order", "detail": "One €138 order on the 11th", "amount": 138, "unit": "month", "category": "shopping"},
            ],
            "actions": [
                {"text": "Cook on Saturdays, keep Wolt for Sundays", "saves_monthly": 70},
                {"text": "Brew coffee at home two days a week", "saves_monthly": 32},
            ],
            "body": "Spending is running about 12% ahead of plan, almost all of it delivery on weekends. "
                    "Groceries and bills are on track. Holding delivery to two orders a week would bring the month back in line.",
            "created_at": now, "model": "demo", "budgets": (insights.get_plan(conn) or {}).get("budgets"),
        })
        db.set_meta(conn, "onboarded", True)
        counts = {acc: len(txs) for acc, txs in rows.items()}
    return {"user_id": user_id, "transactions": counts}

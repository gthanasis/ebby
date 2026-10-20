"""The categories people usually have and Greek banks print: insurance, loans, investments and the rest."""

from app.data import db
from app.domain import categories
from app.domain.categories import CATEGORIES, SPENDING, categorize


def out(description, mcc=None, card=False):
    return categorize(description, mcc, True, card)


def test_insurance_has_its_own_category():
    assert out("ΑΣΦΑΛΙΣΤΡΑ ΑΥΤΟΚΙΝΗΤΟΥ") == "insurance"
    assert out("INTERAMERICAN ΑΣΦΑΛΙΣΗ") == "insurance"
    assert out("", "6300", card=True) == "insurance"  # an insurer's card payment, by category code


def test_loan_instalments_count_as_spending():
    assert out("ΔΟΣΗ ΣΤΕΓΑΣΤΙΚΟΥ 123456") == "loans" and "loans" in SPENDING


def test_investing_is_kept_out_of_spending():
    assert out("TRADE REPUBLIC BANK") == "investments"
    assert out("To investment account") == "investments"
    assert out("", "6211", card=True) == "investments"
    assert "investments" not in SPENDING


def test_education_kids_and_gifts():
    assert out("UDEMY ONLINE COURSES") == "education"
    assert out("ΦΡΟΝΤΙΣΤΗΡΙΟ ΑΓΓΛΙΚΩΝ") == "education"
    assert out("", "8351", card=True) == "kids"
    assert out("UNICEF HELLAS") == "gifts"
    assert out("", "5992", card=True) == "gifts"  # florist, ahead of the general shopping codes


def test_the_old_rules_still_hold():
    assert out("WΟLΤ") == "delivery"
    assert out("ΔΕΗ ΛΟΓΑΡΙΑΣΜΟΣ") == "bills"
    assert out("Anytime Fitness") == "health"  # not taken for the insurer of a similar name
    assert all(c in CATEGORIES for c in ("insurance", "loans", "investments", "education", "kids", "gifts"))


def test_history_is_sorted_again_when_the_rules_change(database, monkeypatch):
    """Rows stored under an older categories.py move to the new categories on the next scheduler round,
    and a person's own rule still wins."""
    import json

    from app.data.import_sqlite import ensure_user
    from app.jobs import sync
    me = ensure_user("recategorize@example.com")

    def tx(text):
        return json.dumps({"remittance_information": [text], "credit_debit_indicator": "DBIT",
                           "transaction_amount": {"amount": "80", "currency": "EUR"}})

    with db.as_user(me), db.connect() as conn:
        conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('acc-R', 'uid-R', 'R', 0, 'Alpha Bank')")
        for i, text in enumerate(["ΑΣΦΑΛΙΣΤΡΑ ΣΠΙΤΙΟΥ", "INTERAMERICAN ΥΓΕΙΑΣ"]):
            conn.execute("""INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, category, raw)
                            VALUES(?, 'acc-R', '2026-10-01', -80, 'EUR', 'BOOK', ?, ?, 'bills', ?)""",
                         (f"acc-R:{i}", text, categories.merchant_name(text), tx(text)))
        conn.execute("INSERT INTO rules(merchant, category) VALUES(?, 'health')", (categories.merchant_name("INTERAMERICAN ΥΓΕΙΑΣ"),))
        db.set_meta(conn, "categories_version", categories.VERSION - 1)

    started = []
    monkeypatch.setattr(sync.threading, "Thread", lambda target, **kw: type("T", (), {"start": lambda self: started.append(target)})())
    monkeypatch.setattr(sync.config, "DEMO", False)
    monkeypatch.setattr(sync, "sync", lambda psu=None: True)
    monkeypatch.setattr(sync.db, "active_users", lambda: [me])
    monkeypatch.setattr(sync.time, "sleep", lambda s: (_ for _ in ()).throw(StopIteration))
    sync.run_scheduler()
    try:
        started[0]()  # one round, then the patched sleep stops the loop
    except StopIteration:
        pass

    with db.as_user(me), db.connect() as conn:
        cats = {r["id"]: r["category"] for r in conn.execute("SELECT id, category FROM transactions")}
        assert cats == {"acc-R:0": "insurance", "acc-R:1": "health"}  # new rule, and their own rule kept
        assert db.get_meta(conn, "categories_version") == categories.VERSION

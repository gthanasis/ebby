"""Every Greek bank Enable Banking supports can be connected, not a fixed few."""

import pytest
from fastapi.testclient import TestClient

from app import banks, config, credentials, db, server, sync
from app.enable_banking import Client

ASPSPS = [
    {"name": "Piraeus Bank", "logo": "https://example.com/piraeus.png", "beta": True, "psu_types": ["business", "personal"],
     "maximum_consent_validity": 180 * 86400},
    {"name": "Alpha Bank", "logo": None, "beta": True, "psu_types": ["personal", "business"], "maximum_consent_validity": 180 * 86400},
    {"name": "Trade Republic", "logo": None, "beta": True, "psu_types": ["personal"], "maximum_consent_validity": 90 * 86400},
    {"name": "SumUp", "logo": None, "beta": True, "psu_types": ["business"], "maximum_consent_validity": 180 * 86400},
]


@pytest.fixture
def enable_banking(monkeypatch, users):
    """B has an Enable Banking app; Enable Banking answers with the list above and records /auth calls."""
    calls = []
    monkeypatch.setattr(Client, "aspsps", lambda self, country: ASPSPS)
    monkeypatch.setattr(Client, "start_auth", lambda self, bank, state, days=config.CONSENT_DAYS: calls.append((bank, days)) or "https://bank.example/approve")
    monkeypatch.setattr(banks, "_cache", {})
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)
    with db.as_user(users["b"]), db.connect() as conn:
        credentials.store(conn, "enable_banking", {"app_id": "x", "pem": "-----BEGIN PRIVATE KEY-----"}, {"app_id": "x"})
    credentials._clients.clear()
    monkeypatch.setattr(server.db, "admin_id", lambda: users["b"])
    yield calls
    with db.as_user(users["b"]), db.connect() as conn:
        conn.execute("DELETE FROM credentials WHERE kind = 'enable_banking'")
    credentials._clients.clear()


def test_every_personal_bank_is_offered(enable_banking):
    names = [b["name"] for b in TestClient(server.app).get("/api/banks").json()["banks"]]
    assert names == ["Alpha Bank", "Piraeus Bank", "Trade Republic"]  # sorted; SumUp is business-only


def test_connecting_piraeus_works_and_respects_the_banks_limit(enable_banking, users):
    client = TestClient(server.app)
    assert client.post("/api/auth/start", json={"bank": "Piraeus Bank"}).json()["url"] == "https://bank.example/approve"
    assert client.post("/api/auth/start", json={"bank": "Trade Republic"}).status_code == 200
    assert enable_banking == [("Piraeus Bank", 180), ("Trade Republic", 90)]
    with db.as_user(users["b"]), db.connect() as conn:
        assert {"Piraeus Bank", "Trade Republic"} <= {c["bank"] for c in db.connections(conn)}


def test_a_bank_enable_banking_doesnt_have_is_refused(enable_banking):
    res = TestClient(server.app).post("/api/auth/start", json={"bank": "Bank of Atlantis"})
    assert res.status_code == 400 and "isn't a bank" in res.json()["detail"]


def test_status_lists_only_your_own_banks(enable_banking, users):
    with db.as_user(users["a"]), db.connect() as conn:
        db.update_connection(conn, "Eurobank", session_id="a-eurobank")
    banks_of_b = {c["bank"] for c in TestClient(server.app).get("/api/status").json()["connections"]}
    assert "Eurobank" not in banks_of_b and "Revolut" not in banks_of_b  # no one else's, no fixed defaults


def test_no_list_before_your_enable_banking_app(monkeypatch, users):
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)
    monkeypatch.setattr(banks, "_cache", {})
    monkeypatch.setattr(server.db, "admin_id", lambda: users["a"])
    res = TestClient(server.app).get("/api/banks")
    assert res.status_code == 400 and "Enable Banking" in res.json()["detail"]


def test_demo_seed_fills_only_the_demo_person(users):
    from app import demo
    result = demo.seed("demo-test@spending.local")
    assert sum(result["transactions"].values()) > 300
    with db.as_user(result["user_id"]), db.connect() as conn:
        spend = {r["category"]: r["n"] for r in conn.execute("SELECT category, COUNT(*) AS n FROM transactions GROUP BY category")}
        assert spend.get("other", 0) < 10 and spend.get("groceries", 0) > 50 and spend.get("transfer", 0) > 0
        assert db.get_meta(conn, "plan") and db.get_meta(conn, "onboarded")
    with db.as_user(users["a"]), db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 3  # A untouched


SANDBOX = [{"name": "Mock ASPSP", "psu_types": ["personal"]}, {"name": "Genome", "psu_types": ["personal"]}]


def test_a_sandbox_app_doesnt_decide_anyone_elses_banks(monkeypatch, users):
    """Enable Banking lists what the asking app can reach, so a sandbox app first in line
    mustn't leave everyone else (or that person, once on production keys) with Mock ASPSP."""
    monkeypatch.setattr(banks, "_cache", {})
    monkeypatch.setattr(Client, "aspsps", lambda self, country: SANDBOX if self.app_id == "sandbox" else ASPSPS)
    credentials._clients.clear()

    def upload(user, app_id):
        with db.as_user(user), db.connect() as conn:
            credentials.store(conn, "enable_banking", {"app_id": app_id, "pem": "-----BEGIN PRIVATE KEY-----"}, {"app_id": app_id})
            credentials.forget_client()

    def offered(user):
        with db.as_user(user):
            return [b["name"] for b in banks.available()]

    try:
        upload(users["a"], "sandbox")
        upload(users["b"], "production-b")
        assert offered(users["a"]) == ["Genome", "Mock ASPSP"]
        assert "Alpha Bank" in offered(users["b"])

        upload(users["a"], "production-a")  # swaps the sandbox key for a production one
        assert "Alpha Bank" in offered(users["a"])
    finally:
        for user in (users["a"], users["b"]):
            with db.as_user(user), db.connect() as conn:
                conn.execute("DELETE FROM credentials WHERE kind = 'enable_banking'")
        credentials._clients.clear()

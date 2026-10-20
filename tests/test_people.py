"""Signing in, each person's keys, the AI allowance and the admin's people, wired together."""

import secrets
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from app import config, server
from app.api import auth
from app.data import credentials, db
from app.data import users as people  # `users` is the fixture with the test people's ids
from app.domain import ai, ai_usage
from app.integrations.enable_banking import Client, EnableBankingError
from app.jobs import sync

APP_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
ORIGIN = {"Origin": "http://testserver"}


def _pem() -> bytes:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


@pytest.fixture
def signed_in(monkeypatch, users):
    """Google sign-in on: a client with a real session cookie for the given user."""
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "test-client")

    def make(who):
        token = secrets.token_urlsafe(32)
        server._store.create_session(users[who], auth.hash_token(token), datetime.now(timezone.utc) + timedelta(days=1), "test")
        client = TestClient(server.app)
        client.cookies.set("session", token)
        return client
    return make


def test_api_needs_a_session(signed_in):
    signed_in("a")  # sign-in is on
    assert TestClient(server.app).get("/api/status").status_code == 401


def test_a_session_acts_as_its_user(signed_in):
    body = signed_in("b").get("/api/transactions").text
    assert "Shop BBB" in body and "AAA" not in body


def test_the_app_shell_loads_signed_out(signed_in):
    signed_in("a")
    assert TestClient(server.app).get("/api/healthz").status_code == 200
    assert TestClient(server.app).get("/").status_code in (200, 404)  # 404 only when web/dist isn't built


def test_writes_must_come_from_the_app(signed_in):
    client = signed_in("b")
    assert client.put("/api/settings", json={"alerts": True}).status_code == 403
    assert client.put("/api/settings", json={"alerts": True}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.put("/api/settings", json={"alerts": True}, headers=ORIGIN).status_code == 200


def test_disabling_someone_signs_them_out(signed_in, users):
    from app.data.import_sqlite import ensure_user
    c = ensure_user("c@example.com")
    token = secrets.token_urlsafe(32)
    server._store.create_session(c, auth.hash_token(token), datetime.now(timezone.utc) + timedelta(days=1), None)
    client = TestClient(server.app)
    client.cookies.set("session", token)
    assert client.get("/api/me").status_code == 200
    people.update(c, status="disabled")
    assert client.get("/api/me").status_code == 401


def test_me_says_what_setup_is_left(signed_in):
    me = signed_in("b").get("/api/me").json()
    assert me["email"] == "b@example.com" and me["onboarding"] == {"bank_access": False, "banks_connected": 1, "done": False}


def test_bank_keys_are_checked_sealed_and_never_shown(signed_in, monkeypatch, users):
    monkeypatch.setattr(Client, "aspsps", lambda self, country: [])
    client = signed_in("b")
    pem = _pem()
    res = client.post("/api/credentials/enable-banking", data={"app_id": APP_ID}, files={"pem": ("key.pem", pem)}, headers=ORIGIN)
    assert res.status_code == 200 and res.json()["app_id"] == APP_ID
    assert "PRIVATE" not in client.get("/api/me").text and client.get("/api/me").json()["credentials"]["enable_banking"]["app_id"] == APP_ID
    with db.as_user(users["b"]), db.connect() as conn:
        row = conn.execute("SELECT ciphertext FROM credentials WHERE kind = 'enable_banking'").fetchone()
        assert b"PRIVATE KEY" not in bytes(row["ciphertext"])
    with db.as_user(users["b"]):
        assert credentials.client().app_id == APP_ID
    with db.as_user(users["a"]), pytest.raises(credentials.MissingCredential):
        credentials.client()


def test_bad_bank_keys_are_refused(signed_in, monkeypatch):
    client = signed_in("b")
    not_pem = client.post("/api/credentials/enable-banking", data={"app_id": APP_ID}, files={"pem": ("key.pem", b"hello")}, headers=ORIGIN)
    assert not_pem.status_code == 400 and "isn't a private key" in not_pem.json()["detail"]

    def refuse(self, country):
        raise EnableBankingError(401, "UNAUTHORIZED", "bad signature")
    monkeypatch.setattr(Client, "aspsps", refuse)
    wrong = client.post("/api/credentials/enable-banking", data={"app_id": APP_ID}, files={"pem": ("key.pem", _pem())}, headers=ORIGIN)
    assert wrong.status_code == 400 and "didn't accept" in wrong.json()["detail"]


def test_onboarding_needs_a_bank(signed_in, users):
    from app.data.import_sqlite import ensure_user
    d = ensure_user("d@example.com")
    token = secrets.token_urlsafe(32)
    server._store.create_session(d, auth.hash_token(token), datetime.now(timezone.utc) + timedelta(days=1), None)
    client = TestClient(server.app)
    client.cookies.set("session", token)
    assert client.post("/api/onboarding/done", headers=ORIGIN).status_code == 400
    assert signed_in("b").post("/api/onboarding/done", headers=ORIGIN).status_code == 204  # b has a connection


def test_bank_redirect_with_someone_elses_state_is_refused(signed_in, users):
    with db.as_user(users["a"]), db.connect() as conn:
        db.update_connection(conn, "Alpha Bank", auth_state="state-of-a")
    res = signed_in("b").get("/eb-callback?state=state-of-a&code=x", follow_redirects=False)
    assert res.status_code == 303 and "/error=" in res.headers["location"]


def test_only_the_admin_manages_people(signed_in):
    assert signed_in("b").get("/api/people").status_code == 403
    admin = signed_in("a")
    assert admin.post("/api/people", json={"email": "New@Example.com", "ai_budget_usd": 3}, headers=ORIGIN).json()["email"] == "new@example.com"
    people = admin.get("/api/people").json()
    assert {"a@example.com", "b@example.com", "new@example.com"} <= {p["email"] for p in people}
    assert "transactions" not in admin.get("/api/people").text


class TestAllowance:
    @pytest.fixture(autouse=True)
    def shared_key(self, monkeypatch):
        monkeypatch.setattr(config, "ANTHROPIC_API_KEY", "sk-ant-owner")

    def _spend(self, user, cost, own=False):
        with db.as_user(user), db.connect() as conn:
            conn.execute("INSERT INTO ai_usage(feature, model, cost_usd, own_key) VALUES('assistant', 'claude-haiku-5-5', ?, ?)", (cost, own))

    def test_over_the_allowance_stops_before_calling(self, users):
        people.update(users["b"], ai_budget_usd=1)
        self._spend(users["b"], 1.5)
        with db.as_user(users["b"]), pytest.raises(ai_usage.BudgetExceeded):
            ai.client("assistant")

    def test_spending_on_your_own_key_doesnt_count(self, users):
        from app.data.import_sqlite import ensure_user
        e = ensure_user("e@example.com")
        self._spend(e, 50, own=True)
        with db.as_user(e):
            assert ai.client("assistant").own_key is False  # still on the shared key, allowance untouched

    def test_your_own_key_has_no_limit(self, users):
        from app.data.import_sqlite import ensure_user
        f = ensure_user("f@example.com")
        self._spend(f, 99)
        with db.as_user(f), db.connect() as conn:
            credentials.store(conn, "anthropic", {"api_key": "sk-ant-friend"}, {"masked": "key ending …iend"})
        with db.as_user(f):
            claude = ai.client("assistant")
        assert claude.own_key and claude.client.api_key == "sk-ant-friend"

    def test_the_admin_has_no_limit(self, users):
        self._spend(users["a"], 500)
        with db.as_user(users["a"]):
            assert ai.client("assistant").client.api_key == "sk-ant-owner"

    def test_usage_is_recorded_per_person(self, users):
        with db.as_user(users["b"]):
            claude = ai.Claude(None, False, "explain")
            ai.record(claude, "claude-opus-5-5", type("U", (), {"input_tokens": 1_000_000, "output_tokens": 0})())
            with db.connect() as conn:
                assert conn.execute("SELECT cost_usd FROM ai_usage WHERE feature = 'explain'").fetchone()[0] == pytest.approx(4.0)
        with db.as_user(users["a"]), db.connect() as conn:
            assert not conn.execute("SELECT 1 FROM ai_usage WHERE feature = 'explain'").fetchone()


def test_import_carries_over_the_old_enable_banking_app(monkeypatch, tmp_path):
    from app.data.import_sqlite import ensure_user
    pem_file = tmp_path / "key.pem"
    pem_file.write_bytes(_pem())
    monkeypatch.setattr(config, "APP_ID", APP_ID)
    monkeypatch.setattr(config, "KEY_PATH", pem_file)
    g = ensure_user("g@example.com", admin=True)
    assert credentials.adopt_env_key(g) is True
    assert credentials.adopt_env_key(g) is False  # once is enough; never over someone's own keys
    with db.as_user(g):
        assert credentials.client().app_id == APP_ID
        with db.connect() as conn:
            assert not db.connections(conn)  # banks are connected from scratch


def test_public_without_a_sign_in_refuses_instead_of_acting_as_the_admin(monkeypatch, users):
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)
    monkeypatch.setattr(config, "GOOGLE_CLIENT_ID", "")
    monkeypatch.setattr(config, "APP_PASSWORD", "")
    monkeypatch.setattr(config, "LOCAL", False)
    res = TestClient(server.app).get("/api/transactions")
    assert res.status_code == 503 and "AAA" not in res.text

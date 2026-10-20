import base64
import hashlib
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api import auth

CLIENT_ID = "client-123.apps.googleusercontent.com"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class FakeStore:
    def __init__(self):
        self.users = {
            "new@example.com": {"id": 1, "email": "new@example.com", "status": "invited", "is_admin": False},
            "old@example.com": {"id": 2, "email": "old@example.com", "status": "active", "is_admin": True},
            "gone@example.com": {"id": 3, "email": "gone@example.com", "status": "disabled", "is_admin": False},
        }
        self.sessions = {}
        self.activated = []

    def user_by_email(self, email):
        return self.users.get(email)

    def activate(self, user_id, name, picture):
        self.activated.append((user_id, name, picture))
        for u in self.users.values():
            if u["id"] == user_id:
                u["status"] = "active"

    def create_session(self, user_id, token_hash, expires_at, user_agent):
        self.sessions[token_hash] = {"user_id": user_id, "expires_at": expires_at}

    def session_user(self, token_hash):
        s = self.sessions.get(token_hash)
        if not s or s["expires_at"] <= datetime.now(timezone.utc):
            return None
        return next(u for u in self.users.values() if u["id"] == s["user_id"] and u["status"] == "active")

    def delete_session(self, token_hash):
        self.sessions.pop(token_hash, None)


def id_token(email="new@example.com", aud=CLIENT_ID, iss="https://accounts.google.com", verified=True, key=KEY, **extra):
    claims = {"iss": iss, "aud": aud, "sub": "g-1", "email": email, "email_verified": verified,
              "name": "New Person", "picture": "https://example.com/p.png",
              "iat": int(time.time()), "exp": int(time.time()) + 3600, **extra}
    return jwt.encode(claims, key, algorithm="RS256")


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", CLIENT_ID)
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "shh")
    monkeypatch.setenv("SESSION_SECRET", "test-secret")
    monkeypatch.setenv("PUBLIC_URL", "http://localhost:8000")
    monkeypatch.setattr(auth, "_jwks", lambda: SimpleNamespace(
        get_signing_key_from_jwt=lambda token: SimpleNamespace(key=KEY.public_key())))


@pytest.fixture
def store():
    return FakeStore()


@pytest.fixture
def client(env, store):
    app = FastAPI()
    app.include_router(auth.router(store))

    @app.get("/me")
    def me(request: Request):
        return auth.current_user(request, store)

    @app.post("/write")
    def write(request: Request):
        return {"ok": auth.origin_ok(request)}

    return TestClient(app, follow_redirects=False)


@pytest.fixture
def google(monkeypatch):
    """Stands in for Google's token endpoint; set .token to the ID token it returns."""
    calls = []
    fake = SimpleNamespace(token=id_token(), calls=calls)

    def post(url, data, timeout):
        assert url == auth.TOKEN_URL
        calls.append(data)
        return SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"id_token": fake.token})

    monkeypatch.setattr(auth.requests, "post", post)
    return fake


def start(client):
    """Follows /auth/google and returns the state Google would send back."""
    r = client.get("/auth/google")
    assert r.status_code == 302
    query = parse_qs(urlparse(r.headers["location"]).query)
    return query["state"][0], query


def sign_in(client, google, **claims):
    google.token = id_token(**claims)
    state, _ = start(client)
    return client.get("/auth/callback", params={"code": "c", "state": state})


def test_authorize_redirect(client):
    _, query = start(client)
    assert query["client_id"] == [CLIENT_ID]
    assert query["scope"] == ["openid email profile"]
    assert query["prompt"] == ["select_account"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["redirect_uri"] == ["http://localhost:8000/auth/callback"]


def test_invited_user_is_activated_and_gets_a_session(client, store, google):
    r = sign_in(client, google, email="New@Example.com")
    assert r.status_code == 302 and r.headers["location"] == "/"
    assert store.activated == [(1, "New Person", "https://example.com/p.png")]
    token = r.cookies["session"]
    assert list(store.sessions) == [hashlib.sha256(token.encode()).digest()]
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie
    assert client.get("/me").json()["email"] == "new@example.com"


def test_pkce_verifier_matches_challenge(client, google):
    state, query = start(client)
    client.get("/auth/callback", params={"code": "c", "state": state})
    verifier = google.calls[0]["code_verifier"]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert query["code_challenge"] == [challenge]


def test_active_user_is_not_reactivated(client, store, google):
    r = sign_in(client, google, email="old@example.com")
    assert r.headers["location"] == "/"
    assert store.activated == [] and len(store.sessions) == 1


@pytest.mark.parametrize("email", ["stranger@example.com", "gone@example.com"])
def test_not_allowed(client, store, google, email):
    r = sign_in(client, google, email=email)
    assert r.headers["location"] == f"/#/login/error=not_allowed&email={email.replace('@', '%40')}"
    assert store.sessions == {} and "session" not in r.cookies


@pytest.mark.parametrize("claims", [
    {"aud": "someone-else"},
    {"verified": False},
    {"iss": "https://evil.example.com"},
    {"key": OTHER_KEY},
    {"exp": int(time.time()) - 10},
])
def test_bad_id_token_fails(client, store, google, claims):
    r = sign_in(client, google, **claims)
    assert r.headers["location"] == "/#/login/error=failed"
    assert store.sessions == {}


def test_bad_state_fails(client, store, google):
    start(client)
    r = client.get("/auth/callback", params={"code": "c", "state": "wrong"})
    assert r.headers["location"] == "/#/login/error=failed"
    assert google.calls == [] and store.sessions == {}


def test_missing_cookie_fails(client, store, google):
    state, _ = start(client)
    client.cookies.clear()
    r = client.get("/auth/callback", params={"code": "c", "state": state})
    assert r.headers["location"] == "/#/login/error=failed"
    assert google.calls == []


def test_tampered_cookie_fails(client, store, google):
    state, _ = start(client)
    body, _, mac = client.cookies["oauth_flow"].partition(".")
    forged = auth._b64(b'{"state":"x","verifier":"y","exp":9999999999}')
    client.cookies.set("oauth_flow", f"{forged}.{mac}", path="/auth")
    r = client.get("/auth/callback", params={"code": "c", "state": "x"})
    assert r.headers["location"] == "/#/login/error=failed"
    assert google.calls == []


def test_expired_flow_cookie_fails(client, google, monkeypatch):
    state, _ = start(client)
    monkeypatch.setattr(auth.time, "time", lambda: 10**10)
    r = client.get("/auth/callback", params={"code": "c", "state": state})
    assert r.headers["location"] == "/#/login/error=failed"


def test_google_error_fails(client):
    r = client.get("/auth/callback", params={"error": "access_denied"})
    assert r.headers["location"] == "/#/login/error=failed"


def test_logout_deletes_session(client, store, google):
    sign_in(client, google)
    assert len(store.sessions) == 1
    r = client.post("/auth/logout")
    assert r.status_code == 303 and r.headers["location"] == "/#/login/signed_out=1"
    assert store.sessions == {}
    assert 'session=""' in r.headers["set-cookie"]
    assert client.get("/me").json() is None


def test_current_user_unknown_or_expired(client, store, google):
    client.cookies.set("session", "nonsense")
    assert client.get("/me").json() is None
    r = sign_in(client, google)
    token_hash = hashlib.sha256(r.cookies["session"].encode()).digest()
    store.sessions[token_hash]["expires_at"] = datetime(2000, 1, 1, tzinfo=timezone.utc)
    assert client.get("/me").json() is None


def test_cookies_are_secure_in_production(client, monkeypatch):
    monkeypatch.setenv("PUBLIC_URL", "https://spending.example.com")
    r = client.get("/auth/google")
    assert "Secure" in r.headers["set-cookie"]
    assert parse_qs(urlparse(r.headers["location"]).query)["redirect_uri"] == ["https://spending.example.com/auth/callback"]


def test_origin_ok(client):
    assert client.post("/write", headers={"origin": "http://testserver"}).json() == {"ok": True}
    assert client.post("/write", headers={"origin": "https://evil.example.com"}).json() == {"ok": False}
    assert client.post("/write").json() == {"ok": False}


def test_origin_ok_behind_ingress(client):
    headers = {"x-forwarded-proto": "https", "x-forwarded-host": "spending.example.com"}
    assert client.post("/write", headers={**headers, "origin": "https://spending.example.com"}).json() == {"ok": True}
    assert client.post("/write", headers={**headers, "origin": "http://spending.example.com"}).json() == {"ok": False}

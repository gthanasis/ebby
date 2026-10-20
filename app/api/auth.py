"""Google sign-in limited to the people in the users table, with server-side sessions.

The OAuth flow is done by hand with requests and pyjwt so there is nothing new to install.
The session cookie holds 32 random bytes; only their sha256 is stored, so a leaked
database row can't be replayed as a cookie.
"""

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Protocol
from urllib.parse import quote, urlencode

import jwt
import requests
from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse
from jwt import PyJWKClient

from app import config  # noqa: F401  loads .env into os.environ

log = logging.getLogger("bank-sync.auth")

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")

SESSION_COOKIE = "session"
SESSION_DAYS = 30
FLOW_COOKIE = "oauth_flow"
FLOW_SECONDS = 600


class AuthStore(Protocol):
    def user_by_email(self, email: str) -> dict | None:
        """{id, email, status, is_admin} or None when the email isn't on the list."""

    def activate(self, user_id, name: str | None, picture: str | None) -> None:
        """First sign-in: invited becomes active, with Google's name and picture."""

    def create_session(self, user_id, token_hash: bytes, expires_at: datetime, user_agent: str | None) -> None: ...

    def session_user(self, token_hash: bytes) -> dict | None:
        """The active user of an unexpired session; slides its expiry when last extended over a day ago."""

    def delete_session(self, token_hash: bytes) -> None: ...


def _client_id() -> str:
    return os.environ["GOOGLE_CLIENT_ID"]


def _public_url() -> str:
    return os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")


def _redirect_uri() -> str:
    return _public_url() + "/auth/callback"


def _secure() -> bool:
    return not _public_url().startswith("http://localhost")


_jwks_client: PyJWKClient | None = None


def _jwks() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(JWKS_URL, cache_keys=True)
    return _jwks_client


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    mac = hmac.new(os.environ["SESSION_SECRET"].encode(), body.encode(), hashlib.sha256).digest()
    return f"{body}.{_b64(mac)}"


def _unsign(value: str) -> dict | None:
    """The payload of a cookie we signed that hasn't expired, else None."""
    body, _, mac = value.partition(".")
    expected = hmac.new(os.environ["SESSION_SECRET"].encode(), body.encode(), hashlib.sha256).digest()
    try:
        if not hmac.compare_digest(_unb64(mac), expected):
            return None
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    return payload if payload.get("exp", 0) > time.time() else None


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def verify_id_token(id_token: str) -> dict:
    """Claims of a Google ID token meant for us, or raises jwt.PyJWTError."""
    key = _jwks().get_signing_key_from_jwt(id_token).key
    claims = jwt.decode(id_token, key, algorithms=["RS256"], audience=_client_id(),
                        options={"require": ["exp", "iss", "aud", "email"]})
    if claims["iss"] not in ISSUERS:
        raise jwt.InvalidIssuerError(f"issuer {claims['iss']}")
    if claims.get("email_verified") is not True:
        raise jwt.InvalidTokenError("email not verified")
    return claims


def current_user(request: Request, store: AuthStore) -> dict | None:
    token = request.cookies.get(SESSION_COOKIE)
    return store.session_user(hash_token(token)) if token else None


def origin_ok(request: Request) -> bool:
    """CSRF check on top of SameSite=Lax: writes must come from our own pages."""
    if request.method in ("GET", "HEAD"):
        return True
    origin = request.headers.get("origin")
    if not origin:
        return False
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    return origin == f"{proto}://{host.split(',')[0].strip()}"


def _failed(reason: str) -> RedirectResponse:
    log.warning("sign-in failed: %s", reason)
    response = RedirectResponse("/#/login/error=failed", status_code=302)
    response.delete_cookie(FLOW_COOKIE, path="/auth")
    return response


def router(store: AuthStore) -> APIRouter:
    r = APIRouter()

    @r.get("/auth/google")
    def google():
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(64)
        challenge = _b64(hashlib.sha256(verifier.encode()).digest())
        query = urlencode({
            "client_id": _client_id(), "redirect_uri": _redirect_uri(), "response_type": "code",
            "scope": "openid email profile", "state": state, "prompt": "select_account",
            "code_challenge": challenge, "code_challenge_method": "S256",
        })
        response = RedirectResponse(f"{AUTHORIZE_URL}?{query}", status_code=302)
        response.set_cookie(FLOW_COOKIE, _sign({"state": state, "verifier": verifier, "exp": time.time() + FLOW_SECONDS}),
                            max_age=FLOW_SECONDS, path="/auth", httponly=True, secure=_secure(), samesite="lax")
        return response

    @r.get("/auth/callback")
    def callback(request: Request, code: str = "", state: str = "", error: str = ""):
        if error:
            return _failed(f"google said {error}")
        flow = _unsign(request.cookies.get(FLOW_COOKIE, ""))
        if not flow or not code or not hmac.compare_digest(state, flow.get("state", "")):
            return _failed("missing or mismatched state")
        try:
            resp = requests.post(TOKEN_URL, timeout=15, data={
                "code": code, "client_id": _client_id(), "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
                "redirect_uri": _redirect_uri(), "grant_type": "authorization_code", "code_verifier": flow["verifier"],
            })
            resp.raise_for_status()
            claims = verify_id_token(resp.json()["id_token"])
        except (requests.RequestException, ValueError, KeyError, jwt.PyJWTError, jwt.PyJWKClientError) as e:
            return _failed(str(e))

        email = claims["email"].lower()
        user = store.user_by_email(email)
        if not user or user["status"] not in ("invited", "active"):
            log.warning("sign-in refused for %s", email)
            response = RedirectResponse(f"/#/login/error=not_allowed&email={quote(email)}", status_code=302)
            response.delete_cookie(FLOW_COOKIE, path="/auth")
            return response
        if user["status"] == "invited":
            store.activate(user["id"], claims.get("name"), claims.get("picture"))

        token = secrets.token_urlsafe(32)
        expires = datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)
        store.create_session(user["id"], hash_token(token), expires, request.headers.get("user-agent"))
        response = RedirectResponse("/", status_code=302)
        response.delete_cookie(FLOW_COOKIE, path="/auth")
        response.set_cookie(SESSION_COOKIE, token, max_age=SESSION_DAYS * 86400, path="/",
                            httponly=True, secure=_secure(), samesite="lax")
        return response

    @r.post("/auth/logout")
    def logout(request: Request):
        token = request.cookies.get(SESSION_COOKIE)
        if token:
            store.delete_session(hash_token(token))
        response = RedirectResponse("/#/login/signed_out=1", status_code=303)
        response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, secure=_secure(), samesite="lax")
        return response

    return r

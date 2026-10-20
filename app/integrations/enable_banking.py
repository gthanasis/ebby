"""Thin Enable Banking API client (restricted mode: each person's own app reaches only their own accounts)."""

import time
from datetime import date, timedelta

import jwt
import requests

from app import clock, config

API = "https://api.enablebanking.com"

# Alpha Bank silently truncates large responses (30-50 newest rows, no continuation
# key), so history is fetched in small windows and any window that looks full is split.
WINDOW_DAYS = 14
SUSPECT_FULL = 30
MAX_HISTORY_DAYS = 545


class EnableBankingError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message

    @property
    def session_expired(self) -> bool:
        return self.code in {"EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"} or self.status == 401


class Client:
    def __init__(self, app_id: str, key: bytes):
        """A person's own restricted-mode application: its ID and private key (see credentials)."""
        self.app_id = app_id
        self.key = key
        self._token, self._token_exp = "", 0

    def _headers(self):
        now = int(time.time())
        if now > self._token_exp - 60:
            self._token_exp = now + 3600
            self._token = jwt.encode(
                {"iss": "enablebanking.com", "aud": "api.enablebanking.com", "iat": now, "exp": self._token_exp},
                self.key, algorithm="RS256", headers={"kid": self.app_id},
            )
        return {"Authorization": f"Bearer {self._token}"}

    def call(self, method: str, path: str, psu: dict | None = None, **kwargs):
        """psu: headers saying the account holder is using the app right now (Psu-Ip-Address, ...).
        Sent only for requests the user triggered; banks then don't count them toward the
        ~4 unattended fetches a day."""
        r = requests.request(method, f"{API}{path}", headers={**self._headers(), **(psu or {})}, timeout=60, **kwargs)
        if not r.ok:
            try:
                body = r.json()
            except ValueError:
                body = {}
            raise EnableBankingError(r.status_code, str(body.get("error") or body.get("code") or ""), body.get("message") or r.text)
        return r.json()

    def aspsps(self, country: str):
        return self.call("GET", "/aspsps", params={"country": country})["aspsps"]

    def start_auth(self, bank: str, state: str, days: int = config.CONSENT_DAYS) -> str:
        """days: how long access lasts, at most what the bank allows (banks.available()'s consent_days)."""
        valid_until = clock.now() + timedelta(days=days)
        return self.call("POST", "/auth", json={
            "access": {"valid_until": valid_until.isoformat()},
            "aspsp": {"name": bank, "country": config.COUNTRY},
            "state": state,
            "redirect_url": config.REDIRECT_URL,
            "psu_type": "personal",
        })["url"]

    def create_session(self, code: str) -> dict:
        return self.call("POST", "/sessions", json={"code": code})

    def balances(self, uid: str, psu: dict | None = None) -> list:
        return self.call("GET", f"/accounts/{uid}/balances", psu=psu).get("balances", [])

    def _window(self, uid: str, start: date, end: date, psu: dict | None = None) -> list:
        params = {"date_from": start.isoformat(), "date_to": end.isoformat()}
        rows = []
        while True:
            page = self.call("GET", f"/accounts/{uid}/transactions", psu=psu, params=params)
            rows += page.get("transactions", [])
            key = page.get("continuation_key")
            if not key:
                break
            params = {**params, "continuation_key": key}
        if len(rows) >= SUSPECT_FULL and start < end:
            mid = start + (end - start) / 2
            return self._window(uid, start, mid, psu) + self._window(uid, mid + timedelta(days=1), end, psu)
        return rows

    def transactions(self, uid: str, days: int, psu: dict | None = None):
        """Yields (start, end, rows) per window, newest first, covering the last `days` days."""
        today = clock.server_today()
        oldest = today - timedelta(days=min(days, MAX_HISTORY_DAYS))
        end = today
        while end >= oldest:
            start = max(oldest, end - timedelta(days=WINDOW_DAYS - 1))
            yield start, end, self._window(uid, start, end, psu)
            end = start - timedelta(days=1)

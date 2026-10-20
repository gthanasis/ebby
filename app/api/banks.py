"""Connecting banks and syncing them: status, the bank list, the bank's approval round trip, live syncs."""

import ipaddress
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app import config
from app.data import credentials, db
from app.domain import alerts, insights
from app.integrations import banks
from app.integrations.enable_banking import EnableBankingError
from app.jobs import sync

router = APIRouter()
LIVE_SYNC_MINUTES = 15


@router.get("/api/status")
def status():
    with db.connect() as conn:
        accounts = [dict(r) for r in conn.execute(
            "SELECT id, bank, name, is_card, last4, balance, balance_at, synced_at, "
            "(SELECT COUNT(*) FROM transactions t WHERE t.account = a.id) AS transactions, "
            "(SELECT MIN(date) FROM transactions t WHERE t.account = a.id) AS since "
            "FROM accounts a ORDER BY bank, is_card, name")]
        # The banks you've connected or started to; the rest are offered from GET /api/banks.
        connections = [{"bank": c["bank"], "connected": bool(c["session_id"]), "valid_until": c["valid_until"],
                        "last_sync": c["last_sync"], "last_error": c["last_error"]} for c in db.connections(conn)]
        open_questions = len(insights.questions(conn))
    synced = [c["last_sync"] for c in connections if c["last_sync"]]
    return {
        "connections": connections,
        "last_sync": min(synced) if synced else None,
        "syncing": sync.is_syncing(),
        "sync_hours": config.SYNC_HOURS,
        # True when the bank redirects back to this app, so connecting needs no copy-paste.
        "callback_in_app": "localhost" not in config.REDIRECT_URL,
        "questions": open_questions,
        "month": insights.this_month(),  # the pay month today is in
        "accounts": [a for a in accounts if a["id"] != insights.CASH_ACCOUNT],
    }


@router.post("/api/sync", status_code=202)
def trigger_sync():
    if sync.is_syncing():
        return {"started": False}

    db.thread(sync.sync)
    return {"started": True}


@router.get("/api/banks")
def get_banks():
    """Every bank Enable Banking connects in this country, for personal accounts."""
    try:
        return {"country": config.COUNTRY, "banks": banks.available()}
    except credentials.MissingCredential as e:
        raise HTTPException(400, str(e))
    except EnableBankingError as e:
        raise HTTPException(502, f"Couldn't get the list of banks from Enable Banking ({e.message}). Try again in a bit.")


class AuthStart(BaseModel):
    bank: str


@router.post("/api/auth/start")
def auth_start(body: AuthStart):
    try:
        return {"url": sync.start_auth(body.bank)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except EnableBankingError as e:
        raise HTTPException(502, e.message)


class AuthComplete(BaseModel):
    address: str


@router.post("/api/auth/complete")
def auth_complete(body: AuthComplete):
    try:
        bank, count = sync.complete_auth(body.address)
        return {"bank": bank, "accounts": count}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except EnableBankingError as e:
        raise HTTPException(502, e.message)


def _psu_headers(request: Request) -> dict | None:
    """The account holder's own IP and browser, so the bank treats the fetch as them being present.
    None when there's no public IP to send (e.g. on the home network without Cloudflare)."""
    ip = (request.headers.get("cf-connecting-ip")
          or request.headers.get("x-forwarded-for", "").split(",")[0].strip()
          or (request.client.host if request.client else ""))
    try:
        if not ipaddress.ip_address(ip).is_global:
            return None
    except ValueError:
        return None
    headers = {"Psu-Ip-Address": ip}
    for src, dst in (("user-agent", "Psu-User-Agent"), ("accept-language", "Psu-Accept-Language"),
                     ("accept", "Psu-Accept"), ("accept-encoding", "Psu-Accept-Encoding")):
        if v := request.headers.get(src):
            headers[dst] = v
    return headers


@router.post("/api/sync/live")
def live_sync(request: Request):
    """Called when the app is opened: fresh data, at most every LIVE_SYNC_MINUTES."""
    from datetime import datetime, timedelta, timezone
    psu = _psu_headers(request)
    if not psu:
        return {"started": False, "reason": "no public IP to send"}
    if sync.is_syncing():
        return {"started": False, "reason": "already syncing"}
    with db.connect() as conn:
        last = db.get_meta(conn, "last_live_sync")
    if last and datetime.fromisoformat(last) > datetime.now(timezone.utc) - timedelta(minutes=LIVE_SYNC_MINUTES):
        return {"started": False, "reason": "synced recently"}

    def run():
        if sync.sync(psu):
            alerts.check()
    db.thread(run)
    return {"started": True}


@router.get("/eb-callback", include_in_schema=False)
def eb_callback(request: Request):
    """Where the bank sends you back after approving (EB_REDIRECT_URL on a real hostname)."""
    with db.connect() as conn:
        page = "accounts" if db.get_meta(conn, "onboarded") else "welcome"  # back to wherever they connected from
    try:
        bank, count = sync.complete_auth(str(request.url))
        return RedirectResponse(f"/#/{page}/connected={quote(bank)}&accounts={count}", status_code=303)
    except (ValueError, EnableBankingError, credentials.MissingCredential) as e:
        return RedirectResponse(f"/#/{page}/error={quote(str(getattr(e, 'message', e)))}", status_code=303)

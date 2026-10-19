import base64
import json
import ipaddress
import mimetypes
import logging
import secrets
from urllib.parse import quote
from datetime import date, timedelta

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from typing import Literal

from pydantic import BaseModel, Field


from . import ai, ai_usage, alerts, assistant, auth, banks, config, credentials, db, habits, insights, push, sorter, spending, sync, users, vault
from .categories import CATEGORIES, SPENDING
from .enable_banking import EnableBankingError

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = FastAPI(title="bank-sync")
mimetypes.add_type("application/manifest+json", ".webmanifest")
# Totals only add up euros; rows in other currencies (Revolut pockets) still show in the list.
SPEND_SQL = f"duplicate_of IS NULL AND commitment_id IS NULL AND currency = 'EUR' AND category IN ({','.join('?' * len(SPENDING))})"
SPEND_ARGS = sorted(SPENDING)


@app.on_event("startup")
def startup():
    db.init()
    if config.ADMIN_EMAIL and db.admin_id() is None:
        from .import_sqlite import ensure_user
        ensure_user(config.ADMIN_EMAIL, admin=True)
    sync.run_scheduler()


PUBLIC_PATHS = {"/api/healthz"}
_store = users.Store()
app.include_router(auth.router(_store))


def _private(path: str) -> bool:
    """Data lives behind /api and the bank's redirect. The app shell and its assets carry none,
    so they load signed out and show the login page."""
    return (path.startswith("/api/") and path not in PUBLIC_PATHS) or path == "/eb-callback"


@app.middleware("http")
async def authenticate(request: Request, call_next):
    if request.url.path in PUBLIC_PATHS or not _private(request.url.path):
        return await call_next(request)

    if config.GOOGLE_CLIENT_ID:
        user = await run_in_threadpool(auth.current_user, request, _store)
        if not user:
            return JSONResponse({"detail": "Sign in first."}, status_code=401)
        if not auth.origin_ok(request):
            return JSONResponse({"detail": "That request didn't come from this app."}, status_code=403)
        user_id = user["id"]
    elif config.APP_PASSWORD:
        header = request.headers.get("authorization", "")
        ok = False
        if header.startswith("Basic "):
            try:
                _, _, password = base64.b64decode(header[6:]).decode().partition(":")
                ok = secrets.compare_digest(password, config.APP_PASSWORD)
            except ValueError:
                ok = False
        if not ok:
            return Response(status_code=401, headers={"WWW-Authenticate": 'Basic realm="ebby"'})
        user_id = await run_in_threadpool(db.admin_id)
    elif config.LOCAL:
        user_id = await run_in_threadpool(db.admin_id)  # local runs without any login act as the admin
    else:
        # Public and no sign-in configured: acting as the admin would hand anyone their money.
        return Response("No sign-in configured: set GOOGLE_CLIENT_ID (or APP_PASSWORD for a private install).", status_code=503)
    if user_id is None:
        return Response("No users yet: set ADMIN_EMAIL or run `bank-sync add-user EMAIL --admin`.", status_code=503)
    # Everything downstream (endpoints, their threads, streams) reads and writes as this user.
    with db.as_user(user_id):
        return await call_next(request)


@app.get("/api/healthz")
def healthz():
    return {"ok": True}


# ---------- the signed-in person, their keys, first-run setup, and the admin's people ----------

def _onboarding(conn) -> dict:
    keys = credentials.public(conn)
    connected = sum(1 for c in db.connections(conn) if c["session_id"])
    return {"bank_access": "enable_banking" in keys, "banks_connected": connected,
            "done": bool(db.get_meta(conn, "onboarded"))}


@app.get("/api/me")
def get_me():
    person = users.me(db.current_user())
    since = ai_usage.month_bounds(insights.local_today())[0]
    with db.connect() as conn:
        keys = credentials.public(conn)
        onboarding = _onboarding(conn)
        # What counts against the allowance: calls on the owner's key this month.
        spent = conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE at >= ? AND NOT own_key", (since,)).fetchone()[0]
    return {"email": person["email"], "name": person["name"], "picture": person["picture"], "is_admin": person["is_admin"],
            "ai_budget_usd": person["ai_budget_usd"], "ai_spent_usd": round(spent, 2), "credentials": keys, "onboarding": onboarding,
            # What each person allows on their own Enable Banking app, so banks can send them back here.
            "eb_redirect_url": config.REDIRECT_URL}


@app.post("/api/credentials/enable-banking")
async def put_bank_access(app_id: str = Form(...), pem: UploadFile = File(...)):
    data = await pem.read(vault.MAX_PEM_BYTES + 1)
    try:
        return await run_in_threadpool(credentials.save_enable_banking, app_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))


class AnthropicKeyIn(BaseModel):
    api_key: str = Field(min_length=10, max_length=400)


@app.post("/api/credentials/anthropic")
def put_anthropic_key(body: AnthropicKeyIn):
    try:
        return credentials.save_anthropic(body.api_key)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.delete("/api/credentials/{kind}", status_code=204)
def delete_credential(kind: Literal["enable_banking", "anthropic"]):
    credentials.remove(kind)


@app.post("/api/onboarding/done", status_code=204)
def onboarding_done():
    with db.connect() as conn:
        if not _onboarding(conn)["banks_connected"]:
            raise HTTPException(400, "Connect at least one bank first.")
        db.set_meta(conn, "onboarded", True)


def _admin():
    if not users.me(db.current_user())["is_admin"]:
        raise HTTPException(403, "Only the admin can manage people.")


@app.get("/api/people")
def get_people():
    _admin()
    return users.people(ai_usage.month_bounds(insights.local_today())[0])


class PersonIn(BaseModel):
    email: str = Field(max_length=200)
    ai_budget_usd: float | None = Field(default=None, ge=0, le=1000)


@app.post("/api/people")
def add_person(body: PersonIn):
    _admin()
    try:
        return users.invite(body.email, body.ai_budget_usd)
    except ValueError as e:
        raise HTTPException(400, str(e))


class PersonPatch(BaseModel):
    status: Literal["active", "disabled"] | None = None
    ai_budget_usd: float | None = Field(default=None, ge=0, le=1000)


@app.patch("/api/people/{user_id}")
def patch_person(user_id: int, body: PersonPatch):
    _admin()
    users.update(user_id, status=body.status, ai_budget_usd=body.ai_budget_usd)
    return users.people(ai_usage.month_bounds(insights.local_today())[0])


def _month(month: str | None) -> tuple[str, str, str]:
    """(YYYY-MM, first day, first day of the next month) of a pay month."""
    key = month or insights.this_month()
    return (key, *insights.month_bounds(key))


_shift = insights.shift


def _spent(conn, start: str, end: str) -> float:
    row = conn.execute(f"SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL}",
                       (start, end, *SPEND_ARGS)).fetchone()
    return round(row[0], 2)


@app.get("/api/categories")
def categories():
    return [{"id": k, "label": label, "icon": icon, "spending": spend} for k, (label, icon, spend) in CATEGORIES.items()]


@app.get("/api/status")
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


@app.get("/api/overview")
def overview(month: str | None = None):
    key, start, end = _month(month)
    today = insights.local_today().isoformat()
    with db.connect() as conn:
        total = _spent(conn, start, end)
        prev_key, prev_start, prev_end = _month(_shift(key, -1))
        prev_total = _spent(conn, prev_start, prev_end)
        # Same point last month, so a half-finished month compares fairly.
        current = start <= today < end
        elapsed = (date.fromisoformat(today) - date.fromisoformat(start)).days + 1
        prev_to_date = _spent(conn, prev_start, (date.fromisoformat(prev_start) + timedelta(days=elapsed)).isoformat()) if current else prev_total

        by_category = [dict(r) for r in conn.execute(f"""
            SELECT category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
            WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY amount DESC
        """, (start, end, *SPEND_ARGS))]
        daily = [dict(r) for r in conn.execute(f"""
            SELECT date, -SUM(amount) AS amount FROM transactions
            WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY date ORDER BY date
        """, (start, end, *SPEND_ARGS))]
        first = _month(_shift(key, -11))[1]
        by_month: dict[str, dict] = {}
        for r in conn.execute(f"""
            SELECT date,
              -SUM(CASE WHEN {SPEND_SQL} THEN amount ELSE 0 END) AS spent,
              SUM(CASE WHEN category = 'income' AND currency = 'EUR' THEN amount ELSE 0 END) AS income
            FROM transactions WHERE date >= ? AND date < ? GROUP BY date
        """, (*SPEND_ARGS, first, end)):
            m = by_month.setdefault(insights.month_of(r["date"]), {"spent": 0.0, "income": 0.0})
            m["spent"] += r["spent"]
            m["income"] += r["income"]
        monthly = [{"month": k, "spent": round(v["spent"], 2), "income": round(v["income"], 2)} for k, v in sorted(by_month.items())]
        merchants = [dict(r) for r in conn.execute(f"""
            SELECT merchant, MAX(category) AS category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
            WHERE date >= ? AND date < ? AND merchant != '' AND {SPEND_SQL}
            GROUP BY merchant HAVING -SUM(amount) > 0 ORDER BY amount DESC LIMIT 8
        """, (start, end, *SPEND_ARGS))]
        income = conn.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = 'income' AND currency = 'EUR'",
                              (start, end)).fetchone()[0]
        count = conn.execute(f"SELECT COUNT(*) FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL} AND amount < 0",
                             (start, end, *SPEND_ARGS)).fetchone()[0]
        oldest = conn.execute("SELECT MIN(date) FROM transactions").fetchone()[0]
        oldest = insights.month_of(oldest) if oldest else None
    return {
        "month": key, "start": start, "end": end, "current": current, "total": total, "count": count, "income": round(income, 2),
        "prev_month": prev_key, "prev_total": prev_total, "prev_to_date": prev_to_date,
        "by_category": by_category, "daily": daily, "monthly": monthly, "merchants": merchants, "oldest_month": oldest,
    }


@app.get("/api/transactions")
def transactions(month: str | None = None, category: str | None = None, account: str | None = None,
                 q: str | None = None, service: str | None = None, commitment: int | None = None,
                 limit: int = 200, offset: int = 0):
    # Debit-card copies are hidden; the current-account row (with the merchant name) stands for both.
    where, args = ["duplicate_of IS NULL", "status != 'OFFSET'"], []
    if month:
        _, start, end = _month(month)
        where.append("date >= ? AND date < ?")
        args += [start, end]
    if category:
        where.append("category = ?")
        args.append(category)
    if account:
        where.append("account = ?")
        args.append(account)
    if commitment is not None:
        where.append("commitment_id = ?")
        args.append(commitment)
    if q:
        where.append("(merchant ILIKE ? OR description ILIKE ?)")
        args += [f"%{q}%", f"%{q}%"]
    if service and category:
        # Services are named in Python (insights.service_name), so filter to their ids first.
        with db.connect() as conn:
            ids = insights.service_transaction_ids(conn, category, service)
        where.append(f"t.id IN ({','.join('?' * len(ids))})" if ids else "0")
        args += ids
    sql_where = f"WHERE {' AND '.join(where)}" if where else ""
    with db.connect() as conn:
        rows = [dict(r) for r in conn.execute(f"""
            SELECT t.id, t.date, t.amount, t.currency, t.status, t.description, t.merchant, t.mcc, t.category,
              t.commitment_id, a.name AS account_name, a.is_card
            FROM transactions t JOIN accounts a ON a.id = t.account {sql_where}
            ORDER BY t.date DESC, t.id LIMIT ? OFFSET ?
        """, (*args, min(limit, 500), offset))]
        total = conn.execute(f"SELECT COUNT(*) FROM transactions t {sql_where}", args).fetchone()[0]
        spent = -(conn.execute(f"SELECT COALESCE(SUM(amount), 0) FROM transactions t {sql_where} AND amount < 0", args).fetchone()[0]) if where else None
    return {"rows": rows, "total": total, "spent": round(spent, 2) if spent is not None else None}


class CategoryChange(BaseModel):
    category: str
    all_from_merchant: bool = False


@app.put("/api/transactions/{tx_id:path}/category")
def set_category(tx_id: str, body: CategoryChange):
    """Moves one payment, or with all_from_merchant every payment to its payee (now and in future).
    Payments given their own category stay as they are either way. Returns how many other payments
    to the payee are still in a different category, so the app can offer to move those too."""
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Unknown category")
    with db.connect() as conn:
        row = conn.execute("SELECT merchant FROM transactions WHERE id = ?", (tx_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No such transaction")
        merchant = row["merchant"]
        key = merchant if body.all_from_merchant and merchant else f"tx:{tx_id}"
        conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
                     (key, body.category))
        if key == merchant:
            # Payments whose own rule now matches the payee's follow the payee again.
            conn.execute("""DELETE FROM rules WHERE category = ? AND merchant IN (
                              SELECT 'tx:' || id FROM transactions WHERE merchant = ?)""", (body.category, merchant))
        db.recategorize(conn)
        others = conn.execute("""
            SELECT COUNT(*) FROM transactions WHERE merchant = ? AND id != ? AND category != ?
              AND duplicate_of IS NULL AND status != 'OFFSET'
              AND 'tx:' || id NOT IN (SELECT merchant FROM rules)
        """, (merchant, tx_id, body.category)).fetchone()[0] if merchant else 0
    return {"ok": True, "rule": key, "merchant": merchant or None, "others": others}


@app.post("/api/sync", status_code=202)
def trigger_sync():
    if sync.is_syncing():
        return {"started": False}

    db.thread(sync.sync)
    return {"started": True}


@app.get("/api/banks")
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


@app.post("/api/auth/start")
def auth_start(body: AuthStart):
    try:
        return {"url": sync.start_auth(body.bank)}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except EnableBankingError as e:
        raise HTTPException(502, e.message)


class AuthComplete(BaseModel):
    address: str


@app.post("/api/auth/complete")
def auth_complete(body: AuthComplete):
    try:
        bank, count = sync.complete_auth(body.address)
        return {"bank": bank, "accounts": count}
    except ValueError as e:
        raise HTTPException(400, str(e))
    except EnableBankingError as e:
        raise HTTPException(502, e.message)


# ---------- redesign: home, plan, pace, services, subscriptions, year, goals, push, AI ----------

def _settings(conn) -> dict:
    model = next((k for k, v in config.ASSISTANT_MODELS.items() if v == config.ASSISTANT_MODEL), "haiku")
    return {"alerts": True, "weekly_read": True, "assistant_model": model, **(db.get_meta(conn, "settings") or {})}


def _goals(conn) -> list[dict]:
    return [insights.goal_view(conn, dict(r)) for r in conn.execute("SELECT * FROM goals ORDER BY target_date")]


@app.get("/api/home")
def home():
    with db.connect() as conn:
        synced = [c["last_sync"] for c in db.connections(conn) if c["session_id"] and c["last_sync"]]
        settings = _settings(conn)
        return {
            "month": insights.today_view(conn), "fresh_at": min(synced) if synced else None,
            # Until payday is set (or the nudge dismissed), offer the one the deposits point to.
            "payday_hint": None if settings.get("payday") or settings.get("payday_dismissed") else insights.detect_payday(conn),
        }


@app.get("/api/spending")
def spending_view(range: str = "month", off: int = 0):
    if range not in spending.RANGES or off > 0:
        raise HTTPException(400, "range is day, week, month or year; off is 0 or less")
    with db.connect() as conn:
        v = spending.view(conn, range, off)
        cached = db.get_meta(conn, f"explain:{range}:{v['start']}")
        # A read stays until the period's spending changes.
        v["explanation"] = cached if cached and cached.get("total") == v["total"] else None
        v["ai"] = ai.available()
        return v


class ExplainIn(BaseModel):
    range: str
    off: int = 0


@app.post("/api/spending/explain")
def spending_explain(body: ExplainIn):
    if body.range not in spending.RANGES or body.off > 0:
        raise HTTPException(400, "range is day, week, month or year; off is 0 or less")
    if not ai.available():
        raise HTTPException(400, "The assistant needs an Anthropic key. Add your own in Settings.")
    with db.connect() as conn:
        v = spending.view(conn, body.range, body.off)
        context = spending.context(conn, body.range, body.off)
    try:
        read = ai.explain(context)
    except (ai_usage.BudgetExceeded, ai_usage.NoAPIKey) as e:
        raise HTTPException(429, str(e))
    if not read:
        raise HTTPException(502, "The assistant couldn't read this period. Try again in a bit.")
    with db.connect() as conn:
        db.set_meta(conn, f"explain:{body.range}:{v['start']}", {**read, "total": v["total"]})
    return read


@app.get("/api/spending/category")
def spending_category(category: str, range: str = "month", off: int = 0):
    if range not in spending.RANGES or off > 0:
        raise HTTPException(400, "range is day, week, month or year; off is 0 or less")
    with db.connect() as conn:
        return spending.category(conn, category, range, off)


@app.get("/api/pace")
def pace(month: str | None = None):
    with db.connect() as conn:
        return insights.pace(conn, month or insights.this_month())


@app.get("/api/category/{category}")
def category(category: str, month: str | None = None):
    if category not in CATEGORIES:
        raise HTTPException(404, "Unknown category")
    with db.connect() as conn:
        return insights.category_detail(conn, category, month or insights.this_month())


@app.get("/api/service")
def service(category: str, name: str, month: str | None = None):
    if category not in CATEGORIES:
        raise HTTPException(404, "Unknown category")
    with db.connect() as conn:
        return insights.service_detail(conn, category, name, month or insights.this_month())


class ServiceMove(BaseModel):
    category: str
    name: str
    to: str


@app.post("/api/service/move")
def move_service(body: ServiceMove):
    """Moves a whole service to another category, now and for future charges from the same merchant."""
    if body.to not in CATEGORIES:
        raise HTTPException(400, "Unknown category")
    with db.connect() as conn:
        ids = insights.service_transaction_ids(conn, body.category, body.name)
        rows = conn.execute(f"SELECT id, merchant FROM transactions WHERE id IN ({','.join('?' * len(ids))})", ids).fetchall() if ids else []
        for r in rows:
            key = r["merchant"] or f"tx:{r['id']}"
            conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
                         (key, body.to))
        db.recategorize(conn)
    return {"moved": len(rows)}


class CommitmentIn(BaseModel):
    name: str
    kind: str = "chosen"
    monthly_limit: float
    note: str = ""
    services: list[str] = []
    off_bank: float = 0
    every_months: int = 1          # 1, 3, 6 or 12
    amount: float | None = None    # each time, for costs paid every few months
    next_date: str | None = None


def _check_commitment(body: CommitmentIn):
    if body.every_months not in (1, 3, 6, 12):
        raise HTTPException(400, "How often is every 1, 3, 6 or 12 months")
    if body.every_months > 1:
        # The budget sets aside a monthly share of a cost paid every few months.
        if not body.amount or body.amount <= 0:
            raise HTTPException(400, "A cost paid every few months needs the amount you pay each time")
        try:
            date.fromisoformat(body.next_date or "")
        except ValueError:
            raise HTTPException(400, "A cost paid every few months needs the date of its next payment")
        body.monthly_limit = round(body.amount / body.every_months, 2)
    else:
        body.amount = body.next_date = None
    if not body.name.strip() or body.monthly_limit <= 0 or body.kind not in ("fixed", "chosen"):
        raise HTTPException(400, "A commitment needs a name, a limit above zero, and kind fixed or chosen")
    if not body.services and body.off_bank <= 0 and body.every_months == 1:
        raise HTTPException(400, "Pick the payments it covers, or the amount you pay outside your accounts")


@app.get("/api/commitments")
def commitments(month: str | None = None):
    with db.connect() as conn:
        return insights.commitments_view(conn, month or insights.this_month())


@app.get("/api/commitments/services")
def commitment_services(transfers: bool = False):
    """Services to pick from when creating a commitment; with transfers, big transfers over 13 months too."""
    with db.connect() as conn:
        return insights.services_seen(conn, 13, True) if transfers else insights.services_seen(conn)


@app.post("/api/commitments")
def add_commitment(body: CommitmentIn):
    _check_commitment(body)
    import json as _json
    from datetime import datetime, timezone
    with db.connect() as conn:
        conn.execute("""INSERT INTO commitments(name, kind, monthly_limit, note, services, off_bank, created_at, every_months, amount, next_date)
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                     (body.name.strip(), body.kind, body.monthly_limit, body.note.strip(), _json.dumps(body.services),
                      max(0, body.off_bank), datetime.now(timezone.utc).isoformat(), body.every_months, body.amount, body.next_date))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())


@app.put("/api/commitments/{cid}")
def edit_commitment(cid: int, body: CommitmentIn):
    _check_commitment(body)
    import json as _json
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM commitments WHERE id = ?", (cid,)).fetchone():
            raise HTTPException(404, "No such commitment")
        conn.execute("""UPDATE commitments SET name = ?, kind = ?, monthly_limit = ?, note = ?, services = ?, off_bank = ?,
                        every_months = ?, amount = ?, next_date = ? WHERE id = ?""",
                     (body.name.strip(), body.kind, body.monthly_limit, body.note.strip(), _json.dumps(body.services), max(0, body.off_bank),
                      body.every_months, body.amount, body.next_date, cid))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())


@app.delete("/api/commitments/{cid}")
def delete_commitment(cid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM commitments WHERE id = ?", (cid,))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())


@app.get("/api/assistant")
def assistant_state():
    with db.connect() as conn:
        qs = insights.questions(conn)
        cash = insights.cash_view(conn, insights.this_month())
    return {**assistant.display(), "questions": qs, "cash": cash, "ai": ai.available()}


class ChatIn(BaseModel):
    text: str


@app.post("/api/assistant/chat")
def assistant_chat(body: ChatIn):
    if not body.text.strip():
        raise HTTPException(400, "Say something first")
    try:
        return assistant.chat(body.text.strip()[:2000])
    except RuntimeError as e:
        raise HTTPException(503, str(e))


@app.post("/api/assistant/chat/stream")
def assistant_chat_stream(body: ChatIn):
    """The reply as it's written, as server-sent events: text, status, then done (or error)."""
    if not body.text.strip():
        raise HTTPException(400, "Say something first")

    def events():
        for event in assistant.chat_events(body.text.strip()[:2000]):
            yield f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/assistant/actions/{action_id}/confirm")
def assistant_confirm(action_id: int):
    try:
        result = assistant.run_action(action_id)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, str(e))
    return {"result": result, **assistant.display()}


@app.post("/api/assistant/actions/{action_id}/cancel")
def assistant_cancel(action_id: int):
    assistant.cancel_action(action_id)
    return assistant.display()


@app.post("/api/assistant/new")
def assistant_new():
    assistant.new_conversation()
    return assistant.display()


class AnswerIn(BaseModel):
    service: str
    category: str


@app.post("/api/assistant/answer")
def assistant_answer(body: AnswerIn):
    """Answer to "what was this?" for a payee left in Other: all its payments, now and later."""
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Unknown category")
    with db.connect() as conn:
        moved = insights.set_service_category(conn, body.service, body.category)
        return {"moved": moved, "questions": insights.questions(conn)}


@app.get("/api/sorter")
def sorter_items():
    with db.connect() as conn:
        return {"items": sorter.items(conn), "ai": ai.available()}


class GuessIn(BaseModel):
    service: str


@app.post("/api/sorter/undo")
def sorter_undo(body: GuessIn):
    """Take back an answer: the payee's rules go, so its payments are worked out as before."""
    with db.connect() as conn:
        return {"moved": insights.clear_service_category(conn, body.service)}


@app.post("/api/sorter/guess")
def sorter_guess(body: GuessIn):
    with db.connect() as conn:
        g = sorter.guess(conn, body.service)
    if not g:
        raise HTTPException(502, "The assistant couldn't make a guess for this one.")
    return g


@app.get("/api/habits")
def habits_overview():
    with db.connect() as conn:
        return habits.overview(conn)


class HabitIn(BaseModel):
    type: str
    category: str | None = None
    target: float
    goal_id: int | None = None


class HabitPatch(BaseModel):
    target: float | None = None
    goal_id: int | None = None
    clear_goal: bool = False


@app.get("/api/habits/weekly")
def habits_weekly():
    with db.connect() as conn:
        return habits.weekly(conn)


@app.post("/api/habits/rules")
def add_habit(body: HabitIn):
    if body.type not in habits.TYPES or body.target <= 0:
        raise HTTPException(400, "A habit needs a type (fewer, spend_less, nospend or wait) and a target above zero")
    if body.type == "nospend" and body.target > 7:
        raise HTTPException(400, "There are 7 days in a week")
    if body.type != "nospend" and body.category not in CATEGORIES:
        raise HTTPException(400, "Pick the category it counts")
    with db.connect() as conn:
        hid = habits.add_rule(conn, body.type, body.category, body.target, body.goal_id)
        return {"id": hid, **habits.weekly(conn)}


@app.get("/api/habits/rules/{hid}")
def habit(hid: int):
    with db.connect() as conn:
        r = conn.execute("SELECT * FROM habit_rules WHERE id = ?", (hid,)).fetchone()
        if not r:
            raise HTTPException(404, "No such habit")
        return habits.habit_view(conn, dict(r), detail=True)


@app.patch("/api/habits/rules/{hid}")
def patch_habit(hid: int, body: HabitPatch):
    with db.connect() as conn:
        r = conn.execute("SELECT * FROM habit_rules WHERE id = ?", (hid,)).fetchone()
        if not r:
            raise HTTPException(404, "No such habit")
        if body.target is not None and body.target > 0:
            conn.execute("UPDATE habit_rules SET target = ? WHERE id = ?", (body.target, hid))
        if body.goal_id is not None or body.clear_goal:
            conn.execute("UPDATE habit_rules SET goal_id = ? WHERE id = ?", (None if body.clear_goal else body.goal_id, hid))
        return habits.habit_view(conn, dict(conn.execute("SELECT * FROM habit_rules WHERE id = ?", (hid,)).fetchone()), detail=True)


@app.delete("/api/habits/rules/{hid}")
def delete_habit(hid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM habit_rules WHERE id = ?", (hid,))
        return habits.weekly(conn)


class SavingsAccountsIn(BaseModel):
    ids: list[str]


@app.put("/api/habits/savings-accounts")
def set_savings_accounts(body: SavingsAccountsIn):
    with db.connect() as conn:
        db.set_meta(conn, "savings_accounts", body.ids)
        return habits.overview(conn)


class WishIn(BaseModel):
    name: str
    price: float


@app.post("/api/wishlist")
def add_wish(body: WishIn):
    if not body.name.strip() or body.price <= 0:
        raise HTTPException(400, "Say what it is and what it costs")
    with db.connect() as conn:
        habits.add_wish(conn, body.name, body.price)
        return habits.overview(conn)


class DecideIn(BaseModel):
    decision: str


@app.post("/api/wishlist/{wid}/decide")
def decide_wish(wid: int, body: DecideIn):
    if body.decision not in ("bought", "skipped", "goal"):
        raise HTTPException(400, "Decision is bought, skipped or goal")
    with db.connect() as conn:
        habits.decide_wish(conn, wid, body.decision)
        return habits.overview(conn)


class YearlyIn(BaseModel):
    name: str
    yearly_amount: float
    due_month: int


@app.post("/api/yearly")
def add_yearly(body: YearlyIn):
    if not body.name.strip() or body.yearly_amount <= 0 or not 1 <= body.due_month <= 12:
        raise HTTPException(400, "A yearly cost needs a name, an amount and the month it's due")
    from datetime import datetime as _dt, timezone as _tz
    with db.connect() as conn:
        conn.execute("INSERT INTO yearly_costs(name, yearly_amount, due_month, created_at) VALUES(?, ?, ?, ?)",
                     (body.name.strip(), body.yearly_amount, body.due_month, _dt.now(_tz.utc).isoformat()))
        return habits.overview(conn)


@app.delete("/api/yearly/{yid}")
def delete_yearly(yid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM yearly_costs WHERE id = ?", (yid,))
        return habits.overview(conn)


@app.get("/api/subscriptions")
def subscriptions():
    with db.connect() as conn:
        return insights.subscriptions(conn)


@app.get("/api/year")
def year(year: int | None = None):
    with db.connect() as conn:
        return insights.year(conn, year or date.today().year)


class PlanIn(BaseModel):
    take_home: float
    keep: float
    budgets: dict[str, float] | None = None
    split: Literal["auto", "custom"] | None = None


@app.get("/api/plan")
def get_plan():
    with db.connect() as conn:
        return {**insights.plan_view(conn), "committed": insights.committed_total(conn),
                "settings": _settings(conn), "devices": push.count(), "ai": ai.available(),
                "payday_detected": insights.detect_payday(conn), "extra_pay": insights.extra_pay(conn)}


@app.post("/api/plan/suggest")
def suggest_plan(body: PlanIn):
    with db.connect() as conn:
        return {"budgets": insights.suggest_budgets(conn, body.take_home, body.keep), "averages": insights.averages(conn),
                "committed": insights.committed_total(conn)}


@app.put("/api/plan")
def put_plan(body: PlanIn):
    if body.take_home <= 0 or body.keep < 0 or body.keep >= body.take_home:
        raise HTTPException(400, "Keep must be less than take-home")
    with db.connect() as conn:
        if body.keep + insights.committed_total(conn) >= body.take_home:
            raise HTTPException(400, "What you keep plus your committed costs leaves nothing to spend")
    with db.connect() as conn:
        return insights.save_plan(conn, body.take_home, body.keep, body.budgets, body.split)


class LimitIn(BaseModel):
    month: str = Field(pattern=r"^\d{4}-\d{2}$")
    limit: float = Field(gt=0)


@app.put("/api/plan/limit")
def put_limit(body: LimitIn):
    with db.connect() as conn:
        if not insights.get_plan(conn):
            raise HTTPException(400, "Set up the plan first")
        return insights.set_limit(conn, body.month, body.limit)


class SettingsIn(BaseModel):
    alerts: bool | None = None
    weekly_read: bool | None = None
    work_hours: float | None = None
    payday: int | Literal["last"] | None = None  # 1 = calendar months, "last" = last working day
    payday_dismissed: bool | None = None
    autofill_dismissed: bool | None = None
    assistant_model: Literal["haiku", "sonnet", "opus"] | None = None
    extra_pay: bool | None = None   # 14 salaries a year: Easter, summer and Christmas bonuses
    owner_names: list[str] | None = None  # your names as banks print them: transfers to these are your own


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    if isinstance(body.payday, int) and not 1 <= body.payday <= 28:
        raise HTTPException(400, "Payday is a day from 1 to 28, or the last working day")
    with db.connect() as conn:
        before = _settings(conn)
        merged = {**before, **body.model_dump(exclude_none=True)}
        db.set_meta(conn, "settings", merged)
        if merged.get("owner_names") != before.get("owner_names"):
            db.recategorize(conn)  # transfers to yourself stop (or start) counting as spending
    if body.payday:
        insights.set_payday(body.payday)
    return merged


class GoalIn(BaseModel):
    name: str
    price: float
    target_date: date
    saved: float = 0
    kind: str = "buy"   # buy something, or save a total (a safety net)


class GoalPatch(BaseModel):
    name: str | None = None
    price: float | None = None
    target_date: date | None = None
    saved: float | None = None
    add: float | None = None


@app.get("/api/goals")
def goals():
    with db.connect() as conn:
        return _goals(conn)


@app.post("/api/goals")
def add_goal(body: GoalIn):
    if not body.name.strip() or body.price <= 0 or body.target_date <= date.today():
        raise HTTPException(400, "A goal needs a name, a price and a date in the future")
    with db.connect() as conn:
        conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at, kind) VALUES(?, ?, ?, ?, ?, ?)",
                     (body.name.strip(), body.price, max(0, body.saved), body.target_date.isoformat(), date.today().isoformat(),
                      body.kind if body.kind in ("buy", "save") else "buy"))
        return _goals(conn)


def _safety_net(conn) -> dict | None:
    """Suggested until you have a savings total: three months of your fixed costs and usual spending, in a year."""
    if conn.execute("SELECT 1 FROM goals WHERE kind = 'save'").fetchone():
        return None
    month = insights.this_month()
    totals = []
    for i in range(1, 7):
        a, b = insights.month_bounds(insights.shift(month, -i))
        totals.append(spending._total(spending._rows(conn, date.fromisoformat(a), date.fromisoformat(b) - timedelta(days=1))))
    totals = [t for t in totals if t > 0]
    if len(totals) < 3:
        return None
    import statistics
    costs = statistics.median(totals) + insights.committed_total(conn)
    amount = float(-(-costs * 3 // 100) * 100)
    return {"name": "Safety net", "price": amount, "kind": "save",
            "target_date": insights._add_months(insights.local_today(), 12).isoformat(), "monthly": round(amount / 12, 2)}


@app.get("/api/goals/overview")
def goals_overview():
    """The Goals tab: saving every month (your plan's savings), totals to save, things to buy, and a suggestion."""
    with db.connect() as conn:
        plan = insights.get_plan(conn)
        items = _goals(conn)
        keep = plan["keep"] if plan else 0
        monthly = round(keep + sum(g["monthly"] for g in items if g["remaining"] > 0), 2)
        committed = insights.committed_total(conn)
        return {
            "save_monthly": habits.pay_yourself_first(conn) if plan else None,
            "goals": items, "monthly": monthly, "committed": committed,
            "take_home": plan["take_home"] if plan else None,
            "left": round(plan["take_home"] - committed - monthly, 2) if plan else None,
            "suggestion": _safety_net(conn),
            "extra_pay": insights.extra_pay(conn),
        }


@app.patch("/api/goals/{goal_id}")
def patch_goal(goal_id: int, body: GoalPatch):
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM goals WHERE id = ?", (goal_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No such goal")
        g = dict(row)
        for k in ("name", "price", "saved"):
            if (v := getattr(body, k)) is not None:
                g[k] = v
        if body.target_date:
            g["target_date"] = body.target_date.isoformat()
        if body.add:
            g["saved"] = max(0, g["saved"] + body.add)
        conn.execute("UPDATE goals SET name = ?, price = ?, saved = ?, target_date = ? WHERE id = ?",
                     (g["name"], g["price"], g["saved"], g["target_date"], goal_id))
        return _goals(conn)


@app.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        return _goals(conn)


@app.get("/api/push/key")
def push_key():
    return {"key": push.public_key()}


class PushSub(BaseModel):
    endpoint: str
    keys: dict[str, str]
    expirationTime: float | None = None


@app.post("/api/push/subscribe")
def push_subscribe(body: PushSub):
    push.subscribe(body.model_dump())
    return {"devices": push.count()}


class PushUnsub(BaseModel):
    endpoint: str


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushUnsub):
    push.unsubscribe(body.endpoint)
    return {"devices": push.count()}


@app.post("/api/push/test")
def push_test():
    sent = push.send("Notifications are on", "This is how cool-down alerts will reach you.", url="/#/plan", tag="test")
    return {"sent": sent}


LIVE_SYNC_MINUTES = 15


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


@app.post("/api/sync/live")
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


@app.post("/api/insights/refresh")
def refresh_insights():
    if not ai.available():
        raise HTTPException(400, "Insights need an Anthropic key. Add your own in Settings.")
    try:
        read = ai.weekly_read()
    except (ai_usage.BudgetExceeded, ai_usage.NoAPIKey) as e:
        raise HTTPException(429, str(e))
    if not read:
        raise HTTPException(502, "The assistant couldn't write this week's read. Try again in a bit.")
    return read


@app.get("/eb-callback", include_in_schema=False)
def eb_callback(request: Request):
    """Where the bank sends you back after approving (EB_REDIRECT_URL on a real hostname)."""
    with db.connect() as conn:
        page = "accounts" if db.get_meta(conn, "onboarded") else "welcome"  # back to wherever they connected from
    try:
        bank, count = sync.complete_auth(str(request.url))
        return RedirectResponse(f"/#/{page}/connected={quote(bank)}&accounts={count}", status_code=303)
    except (ValueError, EnableBankingError, credentials.MissingCredential) as e:
        return RedirectResponse(f"/#/{page}/error={quote(str(getattr(e, 'message', e)))}", status_code=303)


if config.WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=config.WEB_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        file = config.WEB_DIST / path
        if path and file.is_file() and config.WEB_DIST in file.resolve().parents:
            # The service worker and manifest must be re-checked on every load to pick up new builds.
            fresh = path in {"sw.js", "manifest.webmanifest"}
            return FileResponse(file, headers={"Cache-Control": "no-cache"} if fresh else None)
        return FileResponse(config.WEB_DIST / "index.html", headers={"Cache-Control": "no-cache"})

"""Who's signed in, their keys, first-run setup, and the admin's people."""


from typing import Literal

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app import config
from app.data import credentials, db, users, vault
from app.domain import ai_usage, insights

router = APIRouter()


def _onboarding(conn) -> dict:
    keys = credentials.public(conn)
    connected = sum(1 for c in db.connections(conn) if c["session_id"])
    return {"bank_access": "enable_banking" in keys, "banks_connected": connected,
            "done": bool(db.get_meta(conn, "onboarded"))}


@router.get("/api/me")
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


@router.post("/api/credentials/enable-banking")
async def put_bank_access(app_id: str = Form(...), pem: UploadFile = File(...)):
    data = await pem.read(vault.MAX_PEM_BYTES + 1)
    try:
        return await run_in_threadpool(credentials.save_enable_banking, app_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))


class AnthropicKeyIn(BaseModel):
    api_key: str = Field(min_length=10, max_length=400)


@router.post("/api/credentials/anthropic")
def put_anthropic_key(body: AnthropicKeyIn):
    try:
        return credentials.save_anthropic(body.api_key)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/api/credentials/{kind}", status_code=204)
def delete_credential(kind: Literal["enable_banking", "anthropic"]):
    credentials.remove(kind)


@router.post("/api/onboarding/done", status_code=204)
def onboarding_done():
    with db.connect() as conn:
        if not _onboarding(conn)["banks_connected"]:
            raise HTTPException(400, "Connect at least one bank first.")
        db.set_meta(conn, "onboarded", True)


def _admin():
    if not users.me(db.current_user())["is_admin"]:
        raise HTTPException(403, "Only the admin can manage people.")


@router.get("/api/people")
def get_people():
    _admin()
    return users.people(ai_usage.month_bounds(insights.local_today())[0])


class PersonIn(BaseModel):
    email: str = Field(max_length=200)
    ai_budget_usd: float | None = Field(default=None, ge=0, le=1000)


@router.post("/api/people")
def add_person(body: PersonIn):
    _admin()
    try:
        return users.invite(body.email, body.ai_budget_usd)
    except ValueError as e:
        raise HTTPException(400, str(e))


class PersonPatch(BaseModel):
    status: Literal["active", "disabled"] | None = None
    ai_budget_usd: float | None = Field(default=None, ge=0, le=1000)


@router.patch("/api/people/{user_id}")
def patch_person(user_id: int, body: PersonPatch):
    _admin()
    users.update(user_id, status=body.status, ai_budget_usd=body.ai_budget_usd)
    return users.people(ai_usage.month_bounds(insights.local_today())[0])

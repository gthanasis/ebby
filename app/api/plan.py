"""The monthly plan, its working limits, and settings."""


from fastapi import HTTPException
from typing import Literal

from pydantic import BaseModel, Field


from app.domain import ai, insights
from app.integrations import push
from app.data import db
from fastapi import APIRouter

from app.api import common

router = APIRouter()


class PlanIn(BaseModel):
    take_home: float
    keep: float
    budgets: dict[str, float] | None = None
    split: Literal["auto", "custom"] | None = None


@router.get("/api/plan")
def get_plan():
    with db.connect() as conn:
        return {**insights.plan_view(conn), "committed": insights.committed_total(conn),
                "settings": common.settings(conn), "devices": push.count(), "ai": ai.available(),
                "payday_detected": insights.detect_payday(conn), "extra_pay": insights.extra_pay(conn)}


@router.post("/api/plan/suggest")
def suggest_plan(body: PlanIn):
    with db.connect() as conn:
        return {"budgets": insights.suggest_budgets(conn, body.take_home, body.keep), "averages": insights.averages(conn),
                "committed": insights.committed_total(conn)}


@router.put("/api/plan")
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


@router.put("/api/plan/limit")
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


@router.put("/api/settings")
def put_settings(body: SettingsIn):
    if isinstance(body.payday, int) and not 1 <= body.payday <= 28:
        raise HTTPException(400, "Payday is a day from 1 to 28, or the last working day")
    with db.connect() as conn:
        before = common.settings(conn)
        merged = {**before, **body.model_dump(exclude_none=True)}
        db.set_meta(conn, "settings", merged)
        if merged.get("owner_names") != before.get("owner_names"):
            db.recategorize(conn)  # transfers to yourself stop (or start) counting as spending
    if body.payday:
        insights.set_payday(body.payday)
    return merged

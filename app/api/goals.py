"""Savings goals and the safety net."""

from datetime import date, timedelta

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import clock
from app.api import common
from app.data import db
from app.domain import habits, insights, spending

router = APIRouter()


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


@router.get("/api/goals")
def goals():
    with db.connect() as conn:
        return common.goals(conn)


@router.post("/api/goals")
def add_goal(body: GoalIn):
    if not body.name.strip() or body.price <= 0 or body.target_date <= clock.server_today():
        raise HTTPException(400, "A goal needs a name, a price and a date in the future")
    with db.connect() as conn:
        conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at, kind) VALUES(?, ?, ?, ?, ?, ?)",
                     (body.name.strip(), body.price, max(0, body.saved), body.target_date.isoformat(), clock.server_today().isoformat(),
                      body.kind if body.kind in ("buy", "save") else "buy"))
        return common.goals(conn)


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


@router.get("/api/goals/overview")
def goals_overview():
    """The Goals tab: saving every month (your plan's savings), totals to save, things to buy, and a suggestion."""
    with db.connect() as conn:
        plan = insights.get_plan(conn)
        items = common.goals(conn)
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


@router.patch("/api/goals/{goal_id}")
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
        return common.goals(conn)


@router.delete("/api/goals/{goal_id}")
def delete_goal(goal_id: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM goals WHERE id = ?", (goal_id,))
        return common.goals(conn)

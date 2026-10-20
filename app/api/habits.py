"""Habits: pay-yourself-first, habit rules, savings accounts, the wishlist, yearly costs."""


from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.data import db
from app.domain import habits
from app.domain.categories import CATEGORIES

router = APIRouter()


@router.get("/api/habits")
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


@router.get("/api/habits/weekly")
def habits_weekly():
    with db.connect() as conn:
        return habits.weekly(conn)


@router.post("/api/habits/rules")
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


@router.get("/api/habits/rules/{hid}")
def habit(hid: int):
    with db.connect() as conn:
        r = conn.execute("SELECT * FROM habit_rules WHERE id = ?", (hid,)).fetchone()
        if not r:
            raise HTTPException(404, "No such habit")
        return habits.habit_view(conn, dict(r), detail=True)


@router.patch("/api/habits/rules/{hid}")
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


@router.delete("/api/habits/rules/{hid}")
def delete_habit(hid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM habit_rules WHERE id = ?", (hid,))
        return habits.weekly(conn)


class SavingsAccountsIn(BaseModel):
    ids: list[str]


@router.put("/api/habits/savings-accounts")
def set_savings_accounts(body: SavingsAccountsIn):
    with db.connect() as conn:
        db.set_meta(conn, "savings_accounts", body.ids)
        return habits.overview(conn)


class WishIn(BaseModel):
    name: str
    price: float


@router.post("/api/wishlist")
def add_wish(body: WishIn):
    if not body.name.strip() or body.price <= 0:
        raise HTTPException(400, "Say what it is and what it costs")
    with db.connect() as conn:
        habits.add_wish(conn, body.name, body.price)
        return habits.overview(conn)


class DecideIn(BaseModel):
    decision: str


@router.post("/api/wishlist/{wid}/decide")
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


@router.post("/api/yearly")
def add_yearly(body: YearlyIn):
    if not body.name.strip() or body.yearly_amount <= 0 or not 1 <= body.due_month <= 12:
        raise HTTPException(400, "A yearly cost needs a name, an amount and the month it's due")
    from datetime import datetime as _dt
    from datetime import timezone as _tz
    with db.connect() as conn:
        conn.execute("INSERT INTO yearly_costs(name, yearly_amount, due_month, created_at) VALUES(?, ?, ?, ?)",
                     (body.name.strip(), body.yearly_amount, body.due_month, _dt.now(_tz.utc).isoformat()))
        return habits.overview(conn)


@router.delete("/api/yearly/{yid}")
def delete_yearly(yid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM yearly_costs WHERE id = ?", (yid,))
        return habits.overview(conn)

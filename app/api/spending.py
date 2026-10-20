"""Where the money went: home, spending by period, pace, categories, services, subscriptions, the year."""

from datetime import date

from fastapi import HTTPException

from pydantic import BaseModel


from app.domain import ai, ai_usage, insights, spending
from app.data import db
from app.domain.categories import CATEGORIES
from fastapi import APIRouter

from app.api import common

router = APIRouter()


@router.get("/api/home")
def home():
    with db.connect() as conn:
        synced = [c["last_sync"] for c in db.connections(conn) if c["session_id"] and c["last_sync"]]
        settings = common.settings(conn)
        return {
            "month": insights.today_view(conn), "fresh_at": min(synced) if synced else None,
            # Until payday is set (or the nudge dismissed), offer the one the deposits point to.
            "payday_hint": None if settings.get("payday") or settings.get("payday_dismissed") else insights.detect_payday(conn),
        }


@router.get("/api/spending")
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


@router.post("/api/spending/explain")
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


@router.get("/api/spending/category")
def spending_category(category: str, range: str = "month", off: int = 0):
    if range not in spending.RANGES or off > 0:
        raise HTTPException(400, "range is day, week, month or year; off is 0 or less")
    with db.connect() as conn:
        return spending.category(conn, category, range, off)


@router.get("/api/pace")
def pace(month: str | None = None):
    with db.connect() as conn:
        return insights.pace(conn, month or insights.this_month())


@router.get("/api/category/{category}")
def category(category: str, month: str | None = None):
    if category not in CATEGORIES:
        raise HTTPException(404, "Unknown category")
    with db.connect() as conn:
        return insights.category_detail(conn, category, month or insights.this_month())


@router.get("/api/service")
def service(category: str, name: str, month: str | None = None):
    if category not in CATEGORIES:
        raise HTTPException(404, "Unknown category")
    with db.connect() as conn:
        return insights.service_detail(conn, category, name, month or insights.this_month())


class ServiceMove(BaseModel):
    category: str
    name: str
    to: str


@router.post("/api/service/move")
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


@router.get("/api/subscriptions")
def subscriptions():
    with db.connect() as conn:
        return insights.subscriptions(conn)


@router.get("/api/year")
def year(year: int | None = None):
    with db.connect() as conn:
        return insights.year(conn, year or date.today().year)


@router.post("/api/insights/refresh")
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

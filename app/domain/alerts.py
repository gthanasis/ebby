"""Cool-down alerts: run after each sync, push once per category per level per month."""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from app import config
from app.data import db
from app.domain import habits, insights
from app.domain.categories import CATEGORIES
from app.integrations import push

log = logging.getLogger("bank-sync")
LEVELS = {"ahead": 1, "over": 2}


def local_now() -> datetime:
    return datetime.now(ZoneInfo(config.TIMEZONE))


def quiet_hours() -> bool:
    return not 9 <= local_now().hour < 22


def pending(conn, month: str) -> list[dict]:
    """Categories that crossed a level since the last alert this month."""
    sent = (db.get_meta(conn, "alerts_sent") or {}).get(month, {})
    out = []
    for c in insights.pace(conn, month)["categories"]:
        level = LEVELS.get(c["status"])
        if level and level > sent.get(c["category"], 0):
            out.append({**c, "level": level})
    return out


def check_commitments(conn, month: str) -> int:
    """Warns once a month per commitment that goes past its limit. No other advice: it's a chosen cost."""
    sent = (db.get_meta(conn, "commitment_alerts") or {}).get(month, [])
    over = [c for c in insights.commitments_view(conn, month)["items"] if c["over"] and c["id"] not in sent]
    if not over:
        return 0
    if len(over) == 1:
        c = over[0]
        title = f"{c['name']} is past its limit"
        body = f"€{c['spent']:,.0f} this month, your limit is €{c['monthly_limit']:,.0f}."
    else:
        title = "Commitments past their limits"
        body = ", ".join(f"{c['name']} €{c['spent']:,.0f} of €{c['monthly_limit']:,.0f}" for c in over[:3])
    delivered = push.send(title, body, url="/#/committed/", tag=f"committed-{month}")
    if delivered:
        state = db.get_meta(conn, "commitment_alerts") or {}
        db.set_meta(conn, "commitment_alerts", {month: [*state.get(month, []), *(c["id"] for c in over)]})
    return delivered


def check_wishlist(conn) -> int:
    """The 48-hour rule: ask once whether each thing is still worth it."""
    due = habits.due_reminders(conn)
    if not due:
        return 0
    w = due[0]
    hours = f" That's about {w['hours_of_work']:.0f} hours of work." if w["hours_of_work"] else ""
    title = f"Still want {w['name']}?" if len(due) == 1 else f"Still want {w['name']} and {len(due) - 1} more?"
    sent = push.send(title, f"You added it two days ago, €{w['price']:,.0f}.{hours}", url="/#/goals/section=wishlist", tag="wishlist")
    if sent:
        conn.execute(f"UPDATE wishlist SET reminded = 1 WHERE id IN ({','.join('?' * len(due))})", [x["id"] for x in due])
    return sent


def check() -> int:
    """Sends due alerts. Returns how many notifications went out."""
    if quiet_hours():
        return 0  # left pending; the next check after 09:00 sends them
    month = insights.this_month()
    with db.connect() as conn:
        if (db.get_meta(conn, "settings") or {}).get("alerts", True):
            check_commitments(conn, month)
        check_wishlist(conn)
        if not insights.get_plan(conn) or not (db.get_meta(conn, "settings") or {}).get("alerts", True):
            return 0
        due = pending(conn, month)
        if not due:
            return 0
        due.sort(key=lambda c: -(c["spent"] - (c["budget"] or 0)))
        first = due[0]
        label = CATEGORIES[first["category"]][0].lower()
        if len(due) == 1:
            title = f"Time to cool down on {label}" if first["level"] == 2 else f"{CATEGORIES[first['category']][0]} is running ahead"
            body = f"€{first['spent']:,.0f} this month. {first['habit']}"
        else:
            names = ", ".join(CATEGORIES[c["category"]][0].lower() for c in due[:3])
            title = "Time to cool down"
            body = f"Ahead of plan on {names}. Biggest: {label}, €{first['spent']:,.0f} this month."
        sent = push.send(title, body, url=f"/#/spending/category={first['category']}", tag=f"cooldown-{month}")
        if not sent:
            return 0  # no device subscribed yet; keep it pending rather than mark it seen
        log.info("cool-down alert for %s: %d device(s)", ", ".join(c["category"] for c in due), sent)
        state = db.get_meta(conn, "alerts_sent") or {}
        state = {month: {**state.get(month, {}), **{c["category"]: c["level"] for c in due}}}
        db.set_meta(conn, "alerts_sent", state)
        return sent

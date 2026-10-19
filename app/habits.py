"""The habits on the Goals tab: pay yourself first, no-spend days, the 48-hour rule, yearly costs.

They nudge behaviour rather than report it, so each one answers a single question:
- Pay yourself first: since payday, has the money you plan to keep reached your savings?
- No-spend days: how many days this week had no free spending at all?
- 48 hours: is that thing still worth it two days later?
- Yearly costs: what to set aside each month so a yearly bill doesn't wreck one month.
"""

import json
from datetime import date, datetime, timedelta, timezone

from . import db, insights

SAVINGS_HINTS = ("αποταμίευση", "saving", "spare", "fund", "pocket")
PAYDAY_MIN = 1000  # an income deposit at least this big counts as pay
DEFAULT_WORK_HOURS = 160
WAIT = timedelta(hours=48)


def _now():
    return datetime.now(timezone.utc)


# ---------- pay yourself first ----------

def _accounts(conn):
    return [dict(r) for r in conn.execute("SELECT id, bank, name, is_card FROM accounts WHERE is_card = 0 AND id != ? ORDER BY bank, name",
                                          (insights.CASH_ACCOUNT,))]


def savings_account_ids(conn) -> list[str]:
    chosen = db.get_meta(conn, "savings_accounts")
    if chosen is not None:
        return chosen
    # Default: accounts named like savings, and Revolut pockets (named by you, not "Revolut EUR").
    out = []
    for a in _accounts(conn):
        n = a["name"].lower()
        if any(h in n for h in SAVINGS_HINTS) or (a["bank"] == "Revolut" and not a["name"].startswith("Revolut")):
            out.append(a["id"])
    return out


def last_payday(conn) -> dict | None:
    r = conn.execute("""SELECT date, amount FROM transactions WHERE category = 'income' AND amount >= ? AND currency = 'EUR'
                        AND duplicate_of IS NULL ORDER BY date DESC LIMIT 1""", (PAYDAY_MIN,)).fetchone()
    return {"date": r["date"], "amount": round(r["amount"], 2)} if r else None


def pay_yourself_first(conn) -> dict:
    plan = insights.get_plan(conn)
    ids = savings_account_ids(conn)
    payday = last_payday(conn)
    since = payday["date"] if payday else insights.month_bounds(insights.this_month())[0]
    saved = 0.0
    if ids:
        saved = conn.execute(f"""SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN ({','.join('?' * len(ids))})
                                 AND date >= ? AND duplicate_of IS NULL AND currency = 'EUR'""", (*ids, since)).fetchone()[0]
    return {
        "target": plan["keep"] if plan else None, "saved": round(saved, 2), "since": since, "payday": payday,
        "accounts": [{**a, "selected": a["id"] in ids} for a in _accounts(conn)],
    }


# ---------- no-spend days ----------

def _spent_on(conn, d: date) -> float:
    return insights._spent_between(conn, d, d)


def no_spend(conn) -> dict:
    today = insights.local_today()
    monday = today - timedelta(days=today.weekday())
    week = []
    for i in range(7):
        d = monday + timedelta(days=i)
        week.append({"date": d.isoformat(), "spent": _spent_on(conn, d) if d <= today else None})
    # Today isn't over, so it doesn't count yet (card payments also land a day late).
    done = [w for w in week if w["spent"] is not None and w["date"] < today.isoformat()]
    first = date.fromisoformat(insights.month_bounds(insights.this_month())[0])
    best = run = 0
    d = first
    while d < today:
        run = run + 1 if _spent_on(conn, d) <= 0 else 0
        best = max(best, run)
        d += timedelta(days=1)
    return {"week": week, "count_week": sum(1 for w in done if w["spent"] <= 0), "days_done": len(done), "best_month": best}


# ---------- the 48-hour list ----------

def hourly_rate(conn) -> float | None:
    plan = insights.get_plan(conn)
    hours = (db.get_meta(conn, "settings") or {}).get("work_hours", DEFAULT_WORK_HOURS)
    return round(plan["take_home"] / hours, 2) if plan and hours else None


def wishlist(conn) -> list[dict]:
    rate = hourly_rate(conn)
    now = _now()
    out = []
    for r in conn.execute("SELECT * FROM wishlist WHERE decision IS NULL ORDER BY created_at"):
        w = dict(r)
        created = datetime.fromisoformat(w["created_at"])
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        ready_at = created + WAIT
        w["ready_at"] = ready_at.isoformat(timespec="seconds")
        w["ready"] = now >= ready_at
        w["hours_of_work"] = round(w["price"] / rate, 1) if rate else None
        out.append(w)
    return out


def skipped_total(conn, since_days: int = 365) -> float:
    since = (_now() - timedelta(days=since_days)).isoformat()
    return round(conn.execute("SELECT COALESCE(SUM(price), 0) FROM wishlist WHERE decision = 'skipped' AND decided_at >= ?",
                              (since,)).fetchone()[0], 2)


def add_wish(conn, name: str, price: float) -> int:
    conn.execute("INSERT INTO wishlist(name, price, created_at) VALUES(?, ?, ?)", (name.strip(), price, _now().isoformat(timespec="seconds")))
    return conn.execute("SELECT lastval()").fetchone()[0]


def decide_wish(conn, wid: int, decision: str):
    conn.execute("UPDATE wishlist SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL",
                 (decision, _now().isoformat(timespec="seconds"), wid))


def due_reminders(conn) -> list[dict]:
    return [w for w in wishlist(conn) if w["ready"] and not w["reminded"]]


# ---------- yearly costs (set aside monthly) ----------

def yearly(conn) -> dict:
    today = insights.local_today()
    items = []
    for r in conn.execute("SELECT * FROM yearly_costs ORDER BY due_month"):
        y = dict(r)
        due = date(today.year + (y["due_month"] < today.month), y["due_month"], 1)
        months_left = (due.year - today.year) * 12 + due.month - today.month
        items.append({**y, "monthly": round(y["yearly_amount"] / 12, 2), "next_due": due.isoformat()[:7], "months_left": months_left})
    taken = {i["name"].lower() for i in items}
    return {"items": items, "monthly": round(sum(i["monthly"] for i in items), 2),
            "suggestions": [s for s in yearly_suggestions(conn) if s["name"].lower() not in taken]}


def yearly_suggestions(conn) -> list[dict]:
    """Charges that come once a year: insurance and annual fees in the last 15 months."""
    since = (insights.local_today() - timedelta(days=460)).isoformat()
    rows = conn.execute("""SELECT date, amount, description, merchant FROM transactions
        WHERE date >= ? AND amount < -30 AND duplicate_of IS NULL AND currency = 'EUR' AND status != 'OFFSET'
          AND (description LIKE '%ΑΣΦΑΛ%' OR description LIKE '%ΑSFΑL%' OR description LIKE '%ΕΤΗΣΙΑ%' OR description LIKE '%INTERAMERICAN%'
               OR description LIKE '%ΙΝΤΕRΑΜΕRΙCΑΝ%' OR mcc LIKE '63%')""", (since,)).fetchall()
    groups: dict[str, dict] = {}
    for r in rows:
        key = "Insurance" if "ΑΣΦΑΛ" in r["description"] or "ΑSFΑL" in r["description"] or "ΙΝΤΕRΑΜ" in r["description"] or "INTERAM" in r["description"] else "Annual fees"
        g = groups.setdefault(key, {"name": key, "months": {}, "dates": []})
        g["months"][r["date"][:7]] = g["months"].get(r["date"][:7], 0) + -r["amount"]
        g["dates"].append(r["date"])
    out = []
    for g in groups.values():
        last_month = max(g["months"])
        out.append({"name": g["name"], "yearly_amount": round(g["months"][last_month], 2), "due_month": int(last_month[5:7]),
                    "last_paid": max(g["dates"])})
    return out


def overview(conn) -> dict:
    return {
        "pay_first": pay_yourself_first(conn), "no_spend": no_spend(conn),
        "wishlist": wishlist(conn), "skipped_year": skipped_total(conn), "hourly_rate": hourly_rate(conn),
        "yearly": yearly(conn),
    }


# ---------- weekly habits: four kinds of rule, each kept or missed per week ----------
#
# Every habit is one of four types, with the person's own numbers filled in:
# - fewer:      `target` or fewer payments in `category` a week (5 or fewer deliveries)
# - spend_less: under €`target` a week on `category` (under €50 eating out)
# - nospend:    `target` days a week with no free spending at all
# - wait:       buys over €`target` in `category` go through the 48-hour wishlist first
# Weeks run Monday to Sunday. Each finished week is kept or missed, which is what streaks,
# savings and anything game-like later build on.

TYPES = ("fewer", "spend_less", "nospend", "wait")
# The categories "fewer" is suggested for, with what one payment is called.
NOUNS = {"delivery": ("delivery", "deliveries"), "eating_out": ("meal out", "meals out"),
         "coffee_bars": ("coffee or drink out", "coffees and drinks out")}
WEEKS = 8
WEEKS_A_MONTH = 4.33


def _monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


def _cat_label(c: str | None) -> str:
    from .categories import CATEGORIES
    return CATEGORIES[c][0].lower() if c in CATEGORIES else "spending"


def habit_title(r: dict) -> str:
    t, n = r["type"], r["target"]
    if t == "fewer":
        noun = NOUNS.get(r["category"], (None, f"{_cat_label(r['category'])} payments"))[1]
        return f"{n:g} or fewer {noun}"
    if t == "spend_less":
        return f"Under €{n:,.0f} a week on {_cat_label(r['category'])}"
    if t == "nospend":
        return f"{n:g} no-spend days"
    return f"Wait 48 hours over €{n:,.0f}"


def _bought_wishes(conn, a: date, b: date) -> list[float]:
    return [r["price"] for r in conn.execute("SELECT price FROM wishlist WHERE decision = 'bought' AND decided_at >= ? AND decided_at < ?",
                                             ((a - timedelta(days=7)).isoformat(), (b + timedelta(days=2)).isoformat()))]


def _measure(conn, r: dict, a: date, b: date, rows: list[dict]) -> dict:
    """The habit's number for the days a..b: payments, euros, no-spend days or wishlist skips."""
    from . import spending  # late: spending imports insights
    today = insights.local_today()
    mine = [x for x in rows if x["category"] == r["category"]]
    if r["type"] == "fewer":
        return {"value": len(mine), "spent": round(sum(x["amount"] for x in mine), 2)}
    if r["type"] == "spend_less":
        return {"value": round(sum(x["amount"] for x in mine), 2), "spent": round(sum(x["amount"] for x in mine), 2)}
    if r["type"] == "nospend":
        spent_days = {x["date"] for x in rows}
        done = [a + timedelta(days=i) for i in range((b - a).days + 1) if a + timedelta(days=i) < today]  # today isn't over
        return {"value": sum(1 for d in done if d.isoformat() not in spent_days), "spent": None}
    wishes = _bought_wishes(conn, a, b)
    skipped = 0
    for x in mine:
        if x["amount"] > r["target"]:
            match = next((w for w in wishes if abs(w - x["amount"]) <= max(5, w * .2)), None)
            if match is None:
                skipped += 1
            else:
                wishes.remove(match)
    return {"value": skipped, "spent": None}


def _status(r: dict, value: float, finished: bool, days_left: int) -> str:
    t, n = r["type"], r["target"]
    if t == "nospend":
        if value >= n:
            return "kept"
        if finished or value + days_left < n:
            return "missed"
        return "at_risk" if value + days_left == n else "on_track"
    over = value > n if t in ("fewer", "spend_less") else value > 0
    if over:
        return "missed"
    if finished:
        return "kept"
    if t == "fewer" and value == n:
        return "at_risk"
    if t == "spend_less" and value >= n * .85:
        return "at_risk"
    return "on_track"


def _nudge(r: dict, m: dict, status: str, days_left: int) -> str:
    t, n, v = r["type"], r["target"], m["value"]
    if t == "fewer":
        noun = NOUNS.get(r["category"], (None, f"{_cat_label(r['category'])} payments"))[1]
        return f"{v:g} this week, over your {n:g}." if status == "missed" else f"No more {noun} this week keeps it."
    if t == "spend_less":
        return f"€{v:,.0f} this week, over your €{n:,.0f}." if status == "missed" else f"€{n - v:,.0f} left on {_cat_label(r['category'])} this week."
    if t == "nospend":
        if status == "missed":
            return f"{v:g} of {n:g} no-spend days, with too few days left."
        return "Spend nothing today to keep it." if days_left == 1 else f"Spend nothing on the {days_left} days left to keep it."
    return f"A buy over €{n:,.0f} skipped the wishlist this week."


def _rule_rows(conn) -> list[dict]:
    return [dict(r) for r in conn.execute("SELECT * FROM habit_rules ORDER BY created_at, id")]


def habit_view(conn, r: dict, detail: bool = False) -> dict:
    from . import spending
    today = insights.local_today()
    monday = _monday(today)
    sunday = monday + timedelta(days=6)
    created = _monday(date.fromisoformat(r["created_at"][:10]))
    days_left = 7 - today.weekday()  # today included
    rows = spending._rows(conn, monday - timedelta(weeks=WEEKS), sunday)
    weeks = []
    for i in range(WEEKS, -1, -1):
        a = monday - timedelta(weeks=i)
        b = a + timedelta(days=6)
        wk = [x for x in rows if a.isoformat() <= x["date"] <= b.isoformat()]
        m = _measure(conn, r, a, b, wk)
        finished = i > 0
        weeks.append({"start": a.isoformat(), **m, "status": _status(r, m["value"], finished, days_left if not finished else 0),
                      "counted": a >= created, "current": not finished})
    now = weeks[-1]
    streak = 0
    for w in reversed(weeks[:-1]):
        if not w["counted"] or w["status"] != "kept":
            break
        streak += 1
    saved = 0.0
    if r["type"] in ("fewer", "spend_less") and r["baseline"]:
        saved = sum(max(0.0, r["baseline"] - (w["spent"] or 0)) for w in weeks[:-1] if w["counted"])
    out = {**r, "title": habit_title(r), "value": now["value"], "status": now["status"], "streak": streak,
           "saved": round(saved, 2), "days_left": days_left, "nudge": _nudge(r, now, now["status"], days_left)}
    if detail:
        out["weeks"] = weeks
        days = []
        for i in range(7):
            d = monday + timedelta(days=i)
            if d > today:
                days.append({"date": d.isoformat(), "value": None})
                continue
            m = _measure(conn, r, d, d, [x for x in rows if x["date"] == d.isoformat()])
            if r["type"] == "nospend":
                m["value"] = 0 if any(x["date"] == d.isoformat() for x in rows) else (1 if d < today else None)
            days.append({"date": d.isoformat(), "value": m["value"]})
        out["days"] = days
        goal = conn.execute("SELECT id, name FROM goals WHERE id = ?", (r["goal_id"],)).fetchone() if r["goal_id"] else None
        out["goal"] = dict(goal) if goal else None
    return out


def _weekly_stats(conn) -> dict:
    """The last WEEKS finished weeks: payments and euros per category, no-spend days, buys over €50."""
    from . import spending
    monday = _monday(insights.local_today())
    a = monday - timedelta(weeks=WEEKS)
    rows = spending._rows(conn, a, monday - timedelta(days=1))
    cats: dict[str, list] = {}
    for x in rows:
        c = cats.setdefault(x["category"], [0, 0.0, []])
        c[0] += 1
        c[1] += x["amount"]
        c[2].append(x["amount"])
    spent_days = {x["date"] for x in rows}
    nospend = sum(1 for i in range(WEEKS * 7) if (a + timedelta(days=i)).isoformat() not in spent_days) / WEEKS
    first = conn.execute("SELECT MIN(date) FROM transactions").fetchone()[0]
    return {"cats": cats, "nospend": nospend, "enough": bool(first) and first <= a.isoformat()}


def suggestions(conn, taken: list[dict]) -> list[dict]:
    """Habits one step better than how you spend now, biggest saving first. Three at most."""
    s = _weekly_stats(conn)
    if not s["enough"]:
        return []
    used = {(r["type"], r["category"]) for r in taken}
    used_cats = {r["category"] for r in taken if r["category"]}
    out = []
    for cat in ("delivery", "eating_out", "coffee_bars", "shopping"):
        if cat in used_cats or cat not in s["cats"]:
            continue
        n, total, _ = s["cats"][cat]
        per_week, spend_week = n / WEEKS, total / WEEKS
        options = []
        if cat in NOUNS and per_week >= 3:
            target = max(1, round(per_week) - 1)
            options.append({"type": "fewer", "category": cat, "target": target,
                            "why": f"You have about {per_week:.0f} a week, €{total / n:,.0f} each.",
                            "monthly": round((per_week - target) * total / n * WEEKS_A_MONTH, 2)})
        if spend_week >= 40:
            target = max(10, int(spend_week * .8 // 10 * 10))
            options.append({"type": "spend_less", "category": cat, "target": target,
                            "why": f"You usually spend about €{spend_week:,.0f} a week.",
                            "monthly": round((spend_week - target) * WEEKS_A_MONTH, 2)})
        if options:
            out.append(max(options, key=lambda o: o["monthly"]))
    if ("nospend", None) not in used and round(s["nospend"]) < 4:
        now = round(s["nospend"])
        out.append({"type": "nospend", "category": None, "target": min(4, max(2, now + 1)),
                    "why": f"You have about {now} a week now." if now else "Most days have some spending now.", "monthly": None})
    big = [a for a in s["cats"].get("shopping", [0, 0, []])[2] if a > 50]
    if ("wait", "shopping") not in used and len(big) >= 2:
        total = sum(s["cats"]["shopping"][2])
        out.append({"type": "wait", "category": "shopping", "target": 50,
                    "why": f"Shopping was €{total:,.0f} in the last {WEEKS} weeks, €{total / len(s['cats']['shopping'][2]):,.0f} a time.",
                    "monthly": None})
    # The two that save the most, then the ones about how you spend (no-spend days, waiting first).
    money = sorted((o for o in out if o["monthly"]), key=lambda o: -o["monthly"])[:2]
    return [{**o, "title": habit_title(o)} for o in money + [o for o in out if not o["monthly"]]][:4]


def weekly(conn) -> dict:
    """The Habits tab: this week's scorecard, each habit, and suggestions."""
    rules = _rule_rows(conn)
    items = [habit_view(conn, r) for r in rules]
    today = insights.local_today()
    monday = _monday(today)
    order = {"missed": 0, "at_risk": 1}
    worry = sorted((h for h in items if h["status"] in order), key=lambda h: order[h["status"]])
    return {
        "week": {"start": monday.isoformat(), "end": (monday + timedelta(days=6)).isoformat(), "days_left": 7 - today.weekday()},
        "habits": items, "on_track": sum(1 for h in items if h["status"] in ("on_track", "kept")), "total": len(items),
        "nudge": {"status": worry[0]["status"], "title": worry[0]["title"], "text": worry[0]["nudge"]} if worry else None,
        "saved": round(sum(h["saved"] for h in items), 2), "suggestions": suggestions(conn, rules),
    }


def add_rule(conn, type_: str, category: str | None, target: float, goal_id: int | None = None) -> int:
    baseline = 0.0
    if type_ in ("fewer", "spend_less") and category:
        c = _weekly_stats(conn)["cats"].get(category)
        baseline = round(c[1] / WEEKS, 2) if c else 0.0
    conn.execute("INSERT INTO habit_rules(type, category, target, baseline, goal_id, created_at) VALUES(?, ?, ?, ?, ?, ?)",
                 (type_, None if type_ == "nospend" else category, target, baseline, goal_id, _now().isoformat(timespec="seconds")))
    return conn.execute("SELECT lastval()").fetchone()[0]

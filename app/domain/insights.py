"""Everything the screens show beyond raw rows: the plan, pace against it, services,
subscriptions, the year, and where a goal's money can come from.

All money here is euros spent (positive numbers), over spending categories only.
"""

import calendar
import json
import re
import statistics
import time
from collections import defaultdict
from datetime import date, timedelta

from app import clock
from app.data import db
from app.domain.categories import CATEGORIES, SPENDING

# Debit-card copies (duplicate_of set) are left out: their current-account row is the one that counts.
# Free spending: what the plan's budgets, alerts and cuts are about. Committed rows are kept apart.
SPEND_SQL = f"duplicate_of IS NULL AND commitment_id IS NULL AND currency = 'EUR' AND category IN ({','.join('?' * len(SPENDING))})"
SPEND_ARGS = sorted(SPENDING)
COMMITTED_SQL = "duplicate_of IS NULL AND commitment_id IS NOT NULL AND currency = 'EUR'"

# Trimmed harder when income doesn't cover habits; essentials barely move.
DISCRETIONARY = {"eating_out": 1.0, "delivery": 1.0, "shopping": 1.0, "cash": 1.0, "coffee_bars": 1.0,
                 "leisure": 1.0, "subscriptions": 0.8, "other": 0.8, "travel": 0.8, "people": 0.6,
                 "personal_care": 0.6, "pets": 0.3, "car": 0.4, "health": 0.2, "groceries": 0.3,
                 "bills": 0.1, "housing": 0.0, "fees": 0.5, "loans": 0.0, "insurance": 0.1, "kids": 0.2,
                 "education": 0.3, "gifts": 0.8}


# ---------- months ----------
# A "month" is a pay month: from one payday up to the day before the next. It's keyed YYYY-MM by
# the calendar month it mostly covers, so with pay on the 25th "2026-10" runs 25 Sep to 24 Oct.
# Payday 1 (the default) makes it the calendar month; "last" is the last working day. Pay that
# falls on a weekend arrives the Friday before, so the month starts then.

PAYDAY_MIN = 1000  # an income deposit at least this big counts as pay
# Per person, read from their settings and kept a minute: month_bounds runs many times a request, and
# a change made on another pod reaches this one within that minute.
PAYDAY_TTL = 60
_paydays: dict[int, tuple[float, int | str]] = {}


def payday() -> int | str:
    user = db.current_user()
    hit = _paydays.get(user)
    if hit and time.monotonic() - hit[0] < PAYDAY_TTL:
        return hit[1]
    with db.connect() as conn:
        day = (db.get_meta(conn, "settings") or {}).get("payday") or 1
    day = day if day == "last" else int(day)
    _paydays[user] = (time.monotonic(), day)
    return day


def set_payday(day: int | str):
    _paydays[db.current_user()] = (time.monotonic(), day)


def _pay_date(y: int, m: int, day: int | str) -> date:
    last = calendar.monthrange(y, m)[1]
    d = date(y, m, last if day == "last" else min(day, last))
    if day == 1:
        return d
    return d - timedelta(days=max(0, d.weekday() - 4))  # Saturday/Sunday -> Friday


def _ym(month: str) -> tuple[int, int]:
    y, m = (int(p) for p in month.split("-"))
    return y, m


def month_bounds(month: str) -> tuple[str, str]:
    """(first day, first day of the next month) of a pay month."""
    day = payday()
    if day == 1:
        y, m = _ym(month)
        return f"{y:04d}-{m:02d}-01", (date(y + (m == 12), m % 12 + 1, 1)).isoformat()
    # Paid late in the month: that pay starts the next month. Paid early: it starts this one.
    first = shift(month, -1) if day == "last" or day > 15 else month
    return _pay_date(*_ym(first), day).isoformat(), _pay_date(*_ym(shift(first, 1)), day).isoformat()


def month_of(d: date | str) -> str:
    """The pay month a day belongs to."""
    d = date.fromisoformat(d) if isinstance(d, str) else d
    key = f"{d.year:04d}-{d.month:02d}"
    start, end = month_bounds(key)
    if d.isoformat() < start:
        return shift(key, -1)
    if d.isoformat() >= end:
        return shift(key, 1)
    return key


def shift(month: str, delta: int) -> str:
    y, m = _ym(month)
    i = y * 12 + (m - 1) + delta
    return f"{i // 12:04d}-{i % 12 + 1:02d}"


def this_month() -> str:
    return month_of(local_today())


def day_progress(month: str) -> tuple[int, int]:
    """(days elapsed including today, days in the month); a past month counts as complete."""
    start, end = (date.fromisoformat(x) for x in month_bounds(month))
    days = (end - start).days
    today = local_today()
    if start <= today < end:
        return (today - start).days + 1, days
    return (days, days) if today >= end else (0, days)


def detect_payday(conn) -> dict | None:
    """When pay seems to arrive: the day of month that the biggest monthly deposit keeps landing on.
    A Friday deposit also counts for the weekend after it, since weekend pay comes early."""
    since = (local_today() - timedelta(days=240)).isoformat()
    biggest: dict[str, dict] = {}
    for r in conn.execute("""SELECT date, amount FROM transactions WHERE category = 'income' AND amount >= ? AND currency = 'EUR'
                             AND duplicate_of IS NULL AND date >= ? ORDER BY date""", (PAYDAY_MIN, since)):
        k = r["date"][:7]
        if k not in biggest or r["amount"] > biggest[k]["amount"]:
            biggest[k] = r
    votes: dict[int, list] = defaultdict(list)
    for r in biggest.values():
        d = date.fromisoformat(r["date"])
        for extra in ((0, 1, 2) if d.weekday() == 4 else (0,)):
            nd = d + timedelta(days=extra)
            if nd.month == d.month:
                votes[nd.day].append(r)
    if not votes:
        return None
    day, hits = max(votes.items(), key=lambda kv: (len(kv[1]), -kv[0] if kv[0] else 0))
    if len(hits) < 3:
        return None
    last = max(hits, key=lambda r: r["date"])
    return {"day": day, "amount": round(statistics.median(r["amount"] for r in hits), 2), "last": last["date"], "months": len(hits)}


# ---------- services ----------

SERVICE_ALIASES = [
    (r"SDDFTSID", "Direct debit"), (r"ΔΙΑΦΟΡΕΣ ΠΛΗΡΩΜΕΣ", "Bill payment"),
    (r"ANTHROPIC|CLAUDE", "Claude (Anthropic)"), (r"OPENAI|CHATGPT", "OpenAI"), (r"GOOGLE.?\*?ADS|GOOGLE ADS", "Google Ads"),
    (r"GOOGLE", "Google"), (r"SPOTIFY", "Spotify"), (r"NETFLIX", "Netflix"), (r"ITUNES|APPLE\.COM", "Apple"),
    (r"CURSOR", "Cursor"), (r"GITHUB", "GitHub"), (r"PATREON", "Patreon"), (r"HETZNER", "Hetzner"),
    (r"CLOUDFLARE", "Cloudflare"), (r"COSMOTE", "Cosmote"), (r"VODAFONE", "Vodafone"), (r"WOLT", "Wolt"),
    (r"EFOOD", "efood"), (r"UBR\*|UBER", "Uber"), (r"AMAZON|AMZN", "Amazon"), (r"SKROUTZ", "Skroutz"),
    (r"YOUTUBE", "YouTube"), (r"DISNEY", "Disney+"), (r"STEAM", "Steam"),
]
_MCC_NAMES = {"5734": "software", "5815": "digital media", "5816": "games", "5817": "apps", "5818": "digital goods",
              "4816": "online services", "5732": "electronics", "5812": "restaurants", "5813": "bars", "5814": "fast food",
              "5411": "supermarkets", "5541": "fuel", "5542": "fuel", "4784": "tolls", "5499": "food shops",
              "5462": "bakeries", "5912": "pharmacies", "5311": "department stores", "5999": "shops",
              "7523": "parking", "4121": "taxis", "6011": "cash machines"}


def service_name(merchant: str, description: str, is_card: bool, mcc: str | None) -> str:
    """One name per service, so 'Google*Ads9252660411' and 'Google Ads9252660411' add up together."""
    if not merchant:
        if is_card:
            return f"Card · {_MCC_NAMES.get(str(mcc or ''), 'purchases')}"
        merchant = description or "Unknown"
    key = merchant.upper()
    for pattern, name in SERVICE_ALIASES:
        if re.search(pattern, key):
            return name
    # Drop trailing references: "Ab Kirseli 2", "Mytrip 1147531613", "Spotify*P446".
    name = re.sub(r"[\s*#_-]*[A-Z]?\d[\w-]*$", "", merchant).strip(" *-")
    return name or merchant


# ---------- plan ----------

def averages(conn, months: int = 6) -> dict[str, float]:
    """Average monthly spend per category over the last `months` complete months."""
    end = month_bounds(this_month())[0]
    start = month_bounds(shift(this_month(), -months))[0]
    rows = conn.execute(f"""
        SELECT category, -SUM(amount) FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY category
    """, (start, end, *SPEND_ARGS)).fetchall()
    return {r[0]: max(0.0, r[1] / months) for r in rows}


def suggest_budgets(conn, take_home: float, keep: float) -> dict[str, float]:
    """Splits take-home minus savings across categories. When habits cost more than that,
    discretionary categories are trimmed hardest (never below 20% of their average)."""
    avg = {c: a for c, a in averages(conn).items() if a >= 5}
    spendable = max(0.0, take_home - keep - committed_total(conn))
    if not avg:
        return {}
    if sum(avg.values()) <= spendable:
        return {c: _round10(a) for c, a in avg.items()}

    def total(f):
        return sum(a * max(0.2, 1 - f * DISCRETIONARY.get(c, 0.7)) for c, a in avg.items())

    lo, hi = 0.0, 5.0
    for _ in range(50):
        mid = (lo + hi) / 2
        lo, hi = (mid, hi) if total(mid) > spendable else (lo, mid)
    return {c: _round10(a * max(0.2, 1 - hi * DISCRETIONARY.get(c, 0.7))) for c, a in avg.items()}


def _round10(v: float) -> float:
    return max(10.0, round(v / 10) * 10)


def get_plan(conn) -> dict | None:
    return db.get_meta(conn, "plan")


def auto_budgets(conn, take_home: float, keep: float) -> dict[str, float]:
    """The habit-based split, scaled so it adds up to exactly what's free to spend."""
    split = suggest_budgets(conn, take_home, keep)
    spendable = max(0.0, take_home - keep - committed_total(conn))
    total = sum(split.values())
    if not split or not total or not spendable:
        return {}
    out = {c: float(round(v * spendable / total)) for c, v in split.items()}
    biggest = max(out, key=out.get)
    out[biggest] += round(spendable - sum(out.values()))  # rounding leftovers go to the biggest
    return {c: v for c, v in out.items() if v > 0}


def save_plan(conn, take_home: float, keep: float, budgets: dict[str, float] | None, split: str | None = None) -> dict:
    """split "auto" keeps the budgets following income, savings and fixed costs; "custom" keeps
    what you typed. Left out, the plan keeps the split it had (plans from before this were custom)."""
    current = get_plan(conn) or {}
    split = split or current.get("split") or ("auto" if budgets is None else "custom")
    if split == "auto":
        budgets = auto_budgets(conn, take_home, keep)
    plan = {"take_home": take_home, "keep": keep, "split": split,
            "budgets": {c: float(v) for c, v in (budgets or current.get("budgets") or {}).items() if c in SPENDING and v > 0},
            "limits": current.get("limits", {})}
    db.set_meta(conn, "plan", plan)
    return plan


def resplit(conn):
    """After fixed costs change, an automatic split follows them."""
    plan = get_plan(conn)
    if plan and plan.get("split") == "auto":
        save_plan(conn, plan["take_home"], plan["keep"], None, "auto")


def autofill(conn) -> bool:
    """After the first import, set the plan up from what the transactions show: pay and payday from
    the salary deposits, savings from what has actually gone into savings accounts, and an automatic
    split. Does nothing once a plan exists. Settings records it so the app can say so once."""
    if get_plan(conn):
        return False
    pay = detect_payday(conn)
    if not pay:
        return False
    from app.domain import habits
    day = pay["day"] if pay["day"] <= 28 else "last"
    db.set_meta(conn, "settings", {**(db.get_meta(conn, "settings") or {}), "payday": day, "autofilled": True})
    set_payday(day)
    take_home = float(round(pay["amount"]))
    ids = habits.savings_account_ids(conn)
    keep = 0.0
    if ids:
        # What goes into savings each month. Money comes back out between paydays, so the net
        # swings wildly; the typical amount moved in is what you mean to put aside.
        moved = []
        for i in range(1, 4):
            ms, me = month_bounds(shift(this_month(), -i))
            moved.append(conn.execute(f"""SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN ({','.join('?' * len(ids))})
                                          AND amount > 0 AND date >= ? AND date < ? AND duplicate_of IS NULL AND currency = 'EUR'""",
                                      (*ids, ms, me)).fetchone()[0])
        keep = max(0.0, _round_to(statistics.median(moved), 50))
    if keep + committed_total(conn) >= take_home:
        keep = 0.0
    save_plan(conn, take_home, keep, None, "auto")
    return True


def budgets_for(plan: dict | None, month: str) -> dict[str, float]:
    """The budgets that apply to a pay month. The plan's budgets are the goal; a month can carry a
    working limit on the way down to it, which scales every budget in proportion."""
    if not plan:
        return {}
    goal = sum(plan["budgets"].values())
    limit = (plan.get("limits") or {}).get(month)
    if not limit or not goal:
        return dict(plan["budgets"])
    return {c: round(v * limit / goal, 2) for c, v in plan["budgets"].items()}


def set_limit(conn, month: str, limit: float) -> dict:
    plan = get_plan(conn)
    plan.setdefault("limits", {})[month] = float(limit)
    db.set_meta(conn, "plan", plan)
    return plan


def _round_to(v: float, step: int) -> float:
    return float(round(v / step) * step)


def plan_view(conn) -> dict:
    plan = get_plan(conn)
    avg = averages(conn)
    if not plan:
        return {"plan": None, "averages": avg}
    return {"plan": plan, "averages": avg, "total": sum(plan["budgets"].values())}


# ---------- pace ----------

def _category_rows(conn, start: str, end: str) -> dict[str, dict]:
    rows = conn.execute(f"""
        SELECT category, -SUM(amount) AS spent, COUNT(*) FILTER (WHERE amount < 0) AS count FROM transactions
        WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY category
    """, (start, end, *SPEND_ARGS)).fetchall()
    return {r["category"]: {"spent": round(r["spent"], 2), "count": r["count"]} for r in rows}


def habit(category: str, spent: float, count: int, budget: float | None, elapsed: int) -> str:
    """The habit behind a number, in plain words."""
    weeks = max(1.0, elapsed / 7)
    per = spent / count if count else 0
    plan = f" Plan was €{budget:,.0f}." if budget else ""
    if category == "delivery":
        return f"{count} orders, about {count / weeks:.0f} a week.{plan}"
    if category in ("eating_out", "coffee_bars"):
        word = "meals" if category == "eating_out" else "visits"
        return f"{count} {word}, €{per:,.0f} each.{plan}"
    if category == "cash":
        return f"{count} withdrawals, €{per:,.0f} each.{plan}"
    return f"{count} payments, €{per:,.0f} on average.{plan}"


def pace(conn, month: str) -> dict:
    start, end = month_bounds(month)
    elapsed, days = day_progress(month)
    plan = get_plan(conn)
    budgets = budgets_for(plan, month)
    rows = _category_rows(conn, start, end)
    total = round(sum(r["spent"] for r in rows.values()), 2)
    planned = sum(budgets.values()) if plan else None
    expected = planned * elapsed / days if planned else None

    categories = []
    for cat in sorted(set(rows) | set(budgets), key=lambda c: -(rows.get(c, {}).get("spent", 0))):
        r = rows.get(cat, {"spent": 0.0, "count": 0})
        budget = budgets.get(cat)
        status = "none"
        if budget:
            if r["spent"] > budget:
                status = "over"
            elif elapsed and r["spent"] > budget * elapsed / days * 1.15 and r["spent"] - budget * elapsed / days > 25:
                status = "ahead"
            else:
                status = "fine"
        categories.append({
            "category": cat, "spent": r["spent"], "count": r["count"], "budget": budget, "status": status,
            "habit": habit(cat, r["spent"], r["count"], budget, elapsed) if r["count"] else "",
        })
    projected = round(total / elapsed * days, 2) if elapsed and month == this_month() else total
    return {
        "month": month, "start": start, "end": end, "elapsed": elapsed, "days": days, "total": total, "planned": planned,
        "expected_to_date": round(expected, 2) if expected is not None else None,
        "projected": projected, "take_home": (plan or {}).get("take_home"),
        "categories": categories,
    }


# ---------- category detail ----------

def category_detail(conn, category: str, month: str) -> dict:
    start, end = month_bounds(month)
    services = defaultdict(lambda: {"amount": 0.0, "count": 0, "accounts": set()})
    for r in conn.execute("""
        SELECT t.amount, t.merchant, t.description, t.mcc, a.name AS account, a.is_card FROM transactions t
        JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.date < ? AND t.category = ? AND t.currency = 'EUR'
          AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
    """, (start, end, category)):
        s = services[service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])]
        s["amount"] -= r["amount"]
        s["count"] += 1
        s["accounts"].add(r["account"])
    history = []
    for i in range(5, -1, -1):
        m = shift(month, -i)
        ms, me = month_bounds(m)
        v = conn.execute("SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = ? AND currency = 'EUR' AND duplicate_of IS NULL AND commitment_id IS NULL",
                         (ms, me, category)).fetchone()[0]
        history.append({"month": m, "spent": round(v, 2)})
    budget = budgets_for(get_plan(conn), month).get(category)
    return {
        "category": category, "month": month, "budget": budget, "history": history,
        "spent": round(sum(s["amount"] for s in services.values()), 2),
        "services": sorted(({"name": n, "amount": round(s["amount"], 2), "count": s["count"],
                             "accounts": sorted(s["accounts"])} for n, s in services.items() if s["amount"] > 0),
                           key=lambda s: -s["amount"]),
    }


# ---------- subscriptions ----------

def subscriptions(conn) -> dict:
    """Services charged in at least 3 of the last 6 months, with a steady-ish monthly cost."""
    since = month_bounds(shift(this_month(), -6))[0]
    by_service = defaultdict(lambda: defaultdict(float))
    last = {}
    for r in conn.execute("""
        SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
        JOIN accounts a ON a.id = t.account
        WHERE t.date >= ? AND t.currency = 'EUR' AND t.amount < 0 AND t.duplicate_of IS NULL
          AND t.category IN ('subscriptions', 'bills', 'health', 'leisure', 'insurance', 'loans', 'education')
    """, (since,)):
        if r["is_card"] and not r["merchant"]:
            continue  # card rows have no name, so they can't be told apart as services
        name = service_name(r["merchant"], r["description"], False, r["mcc"])
        by_service[name][month_of(r["date"])] += -r["amount"]
        last[name] = max(last.get(name, ""), r["date"])
    today = clock.server_today()
    items = []
    for name, months in by_service.items():
        if len(months) < 3:
            continue
        recent = [months[m] for m in sorted(months)[-3:]]
        monthly = round(statistics.median(recent), 2)
        last_charge = date.fromisoformat(last[name])
        stale = (today - last_charge).days > 45
        items.append({
            "name": name, "monthly": monthly, "months": len(months), "last_charge": last[name],
            "next_charge": None if stale else (last_charge + timedelta(days=30)).isoformat(),
            "varies": max(recent) - min(recent) > max(2.0, monthly * 0.15), "stale": stale,
        })
    items.sort(key=lambda s: (s["stale"], -s["monthly"]))
    active = [s for s in items if not s["stale"]]
    monthly = round(sum(s["monthly"] for s in active), 2)
    return {"items": items, "monthly": monthly, "yearly": round(monthly * 12, 2), "count": len(active)}


# ---------- year ----------

def year(conn, y: int) -> dict:
    start, end = month_bounds(f"{y}-01")[0], month_bounds(f"{y}-12")[1]
    months = _months_spent(conn, start, end)
    cats = [dict(r) for r in conn.execute(f"""
        SELECT category, -SUM(amount) AS spent, COUNT(*) AS count FROM transactions
        WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY spent DESC
    """, (start, end, *SPEND_ARGS))]
    total = round(sum(m["spent"] for m in months), 2)
    plan = get_plan(conn)
    monthly_plan = sum(plan["budgets"].values()) if plan else None
    peak = max(months, key=lambda m: m["spent"]) if months else None
    peak_cat = None
    if peak:
        ps, pe = month_bounds(peak["month"])
        row = conn.execute(f"""
            SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL}
            GROUP BY category ORDER BY spent DESC LIMIT 1
        """, (ps, pe, *SPEND_ARGS)).fetchone()
        peak_cat = dict(row) if row else None
    under = [m["month"] for m in months if monthly_plan and m["spent"] <= monthly_plan]
    committed = conn.execute(f"SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND {COMMITTED_SQL}",
                             (start, end)).fetchone()[0]
    return {
        "year": y, "total": total, "months": months, "categories": cats,
        "monthly_average": round(total / len(months), 2) if months else 0,
        "monthly_plan": monthly_plan, "peak": peak, "peak_category": peak_cat, "under_plan": under,
        "committed": round(committed, 2),
        "years": [r[0] for r in conn.execute("SELECT DISTINCT substr(date, 1, 4) FROM transactions ORDER BY 1")],
    }


def _months_spent(conn, start: str, end: str) -> list[dict]:
    """Free spending per pay month between two days, oldest first."""
    by = defaultdict(float)
    for r in conn.execute(f"SELECT date, -SUM(amount) FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY date",
                          (start, end, *SPEND_ARGS)):
        by[month_of(r[0])] += r[1]
    return [{"month": m, "spent": round(v, 2)} for m, v in sorted(by.items())]


# ---------- goals ----------

def goal_view(conn, goal: dict) -> dict:
    remaining = max(0.0, goal["price"] - goal["saved"])
    days = max(1, (date.fromisoformat(goal["target_date"]) - clock.server_today()).days)
    weekly = remaining / (days / 7)
    monthly = remaining / (days / 30.44)
    return {**goal, "remaining": round(remaining, 2), "weeks_left": max(1, round(days / 7)),
            "weekly": round(weekly, 2), "monthly": round(monthly, 2), "cuts": cuts(conn, monthly)}


def cuts(conn, needed_monthly: float) -> list[dict]:
    """Concrete changes from your last 3 months, biggest first, until they cover the goal."""
    start = month_bounds(shift(this_month(), -3))[0]
    end = month_bounds(this_month())[0]
    stats = {r["category"]: dict(r) for r in conn.execute(f"""
        SELECT category, -SUM(amount) / 3.0 AS monthly, COUNT(*) FILTER (WHERE amount < 0) / 3.0 AS per_month,
               -SUM(amount) / GREATEST(1, COUNT(*) FILTER (WHERE amount < 0)) AS avg FROM transactions
        WHERE date >= ? AND date < ? AND {SPEND_SQL} GROUP BY category
    """, (start, end, *SPEND_ARGS))}
    options = []
    if (d := stats.get("delivery")) and d["per_month"] >= 4:
        options.append({"category": "delivery", "text": "1 fewer delivery a week",
                        "detail": f"you average €{d['avg']:,.0f} an order", "monthly": round(d["avg"] * 4.33, 2)})
    if (e := stats.get("eating_out")) and e["per_month"] >= 4:
        options.append({"category": "eating_out", "text": "Eat out 3 fewer times a month",
                        "detail": f"€{e['avg']:,.0f} a meal", "monthly": round(e["avg"] * 3, 2)})
    if (c := stats.get("coffee_bars")) and c["per_month"] >= 6:
        options.append({"category": "coffee_bars", "text": "Skip a third of coffee and bar visits",
                        "detail": f"€{c['avg']:,.0f} a visit", "monthly": round(c["monthly"] / 3, 2)})
    if (s := stats.get("shopping")) and s["monthly"] >= 100:
        options.append({"category": "shopping", "text": "Cut shopping by a quarter",
                        "detail": f"usually €{s['monthly']:,.0f} a month", "monthly": round(s["monthly"] / 4, 2)})
    if (x := stats.get("cash")) and x["monthly"] >= 200:
        options.append({"category": "cash", "text": "Withdraw €50 less cash a week",
                        "detail": f"usually €{x['monthly']:,.0f} a month in cash", "monthly": round(50 * 4.33, 2)})
    subs = subscriptions(conn)
    for sub in [s for s in subs["items"] if not s["stale"] and s["monthly"] >= 8][:2]:
        options.append({"category": "subscriptions", "text": f"Pause {sub['name']} until then",
                        "detail": "charged monthly", "monthly": sub["monthly"]})
    # Small, specific habits first (they stick); the blunt levers only if those aren't enough.
    order = ["delivery", "eating_out", "subscriptions", "coffee_bars", "shopping", "cash"]
    options.sort(key=lambda o: (order.index(o["category"]), -o["monthly"]))
    chosen, total = [], 0.0
    for o in options:
        if total >= needed_monthly and len(chosen) >= 2:
            break
        chosen.append(o)
        total += o["monthly"]
    return chosen


# ---------- day / week / month for the Home card ----------

def local_today() -> date:
    return clock.today()


def _spent_between(conn, start: date, end: date) -> float:
    """Spending from start up to and including end."""
    row = conn.execute(f"SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date <= ? AND {SPEND_SQL}",
                       (start.isoformat(), end.isoformat(), *SPEND_ARGS)).fetchone()
    return round(row[0], 2)


def today_view(conn) -> dict:
    """This pay month so far, for Today: each day's spending, the average day, where the month
    ends at that pace, and where the money went. Everything counts the same days (the start of
    the month up to and including today), so the totals agree."""
    today = local_today()
    month = this_month()
    first, end = (date.fromisoformat(x) for x in month_bounds(month))
    length = (end - first).days
    by_day = {r[0]: round(r[1], 2) for r in conn.execute(
        f"SELECT date, -SUM(amount) FROM transactions WHERE date >= ? AND date <= ? AND {SPEND_SQL} GROUP BY date",
        (first.isoformat(), today.isoformat(), *SPEND_ARGS))}
    days = [{"date": d.isoformat(), "spent": by_day.get(d.isoformat(), 0.0) if d <= today else None}
            for d in (first + timedelta(days=i) for i in range(length))]
    spent = round(sum(by_day.values()), 2)
    elapsed = (today - first).days + 1
    rows = _category_rows(conn, first.isoformat(), (today + timedelta(days=1)).isoformat())
    categories = sorted(({"category": c, **r} for c, r in rows.items() if r["spent"] > 0), key=lambda c: -c["spent"])
    return {
        "month": month, "start": first.isoformat(), "end": end.isoformat(), "today": today.isoformat(),
        "length": length, "elapsed": elapsed, "spent": spent, "days": days,
        "average": round(spent / elapsed, 2), "projected": round(spent / elapsed * length, 2),
        "categories": categories, "ideal": _ideal(conn, length),
    }


def _ideal(conn, length: int) -> dict | None:
    """What the month should look like: income less savings, fixed costs and what each goal needs
    a month, shared over the days and across categories in the plan's proportions."""
    plan = get_plan(conn)
    if not plan:
        return None
    goals = []
    for r in conn.execute("SELECT name, price, saved, target_date FROM goals ORDER BY target_date"):
        days_left = max(1, (date.fromisoformat(r["target_date"]) - local_today()).days)
        goals.append({"name": r["name"], "price": r["price"], "target_date": r["target_date"],
                      "monthly": round(max(0.0, r["price"] - r["saved"]) / (days_left / 30.44), 2)})
    fixed = committed_total(conn)
    budget = max(0.0, plan["take_home"] - plan["keep"] - fixed - sum(g["monthly"] for g in goals))
    shares = plan["budgets"]
    total = sum(shares.values())
    return {
        "income": plan["take_home"], "savings": plan["keep"], "fixed": fixed, "goals": goals,
        "budget": round(budget, 2), "day": round(budget / length, 2),
        "targets": {c: round(v * budget / total, 2) for c, v in shares.items()} if total else {},
    }


def periods(conn) -> dict | None:
    """What's left today, this week and this month. None without a plan.

    Day: what's left of the month shared over the days to go (today included) - mode "share".
    When that's out of reach (the plan is used up, or staying on it would take under 60% of the
    recent daily pace) a plan day would just be ignored, so mode "catch_up" sets a realistic day
    instead: three quarters of the recent pace, never below a plan day, never above the pace itself.
    finish is where the month lands at that rate, and suggest_limit offers a working limit for
    next month on the way back down to the plan (or for this month, early in it, after a bad one).
    Week: Monday to Sunday, limit = a normal plan day x 7.
    Month: every day's spending so far (None for days still to come), for the day strip.
    """
    plan = get_plan(conn)
    if not plan:
        return None
    today = local_today()
    month = this_month()
    first, end = (date.fromisoformat(x) for x in month_bounds(month))
    days = (end - first).days
    goal = sum(plan["budgets"].values())
    monthly = sum(budgets_for(plan, month).values())
    per_day = monthly / days
    month_spent = _spent_between(conn, first, end - timedelta(days=1))
    before_today = _spent_between(conn, first, today - timedelta(days=1)) if today > first else 0.0
    today_spent = _spent_between(conn, today, today)
    days_left = (end - today).days
    left_for_month = monthly - before_today
    gone = (today - first).days
    pace_daily = before_today / gone if gone >= 3 else None
    need = left_for_month / days_left
    if pace_daily and (need <= 0 or need < 0.6 * pace_daily) and pace_daily > per_day:
        day_limit, mode = min(pace_daily, max(per_day, need, _round_to(0.75 * pace_daily, 5))), "catch_up"
    elif need > 0:
        day_limit, mode = need, "share"
    else:
        day_limit, mode = per_day, "catch_up"
    finish = before_today + day_limit * days_left

    limits = plan.get("limits") or {}
    suggest = None
    if mode == "catch_up" and shift(month, 1) not in limits:
        suggest = {"month": shift(month, 1), "limit": max(goal, _round_to(0.9 * finish, 50)), "goal": goal}
    elif month not in limits and gone <= 5:
        ps, pe = month_bounds(shift(month, -1))
        last = _spent_between(conn, date.fromisoformat(ps), date.fromisoformat(pe) - timedelta(days=1))
        if last > goal * 1.05:
            suggest = {"month": month, "limit": max(goal, _round_to(0.9 * last, 50)), "goal": goal, "last": last}

    monday = today - timedelta(days=today.weekday())
    week_days = []
    for i in range(7):
        d = monday + timedelta(days=i)
        week_days.append({"date": d.isoformat(), "spent": _spent_between(conn, d, d) if d <= today else None})
    week_spent = round(sum(d["spent"] or 0 for d in week_days), 2)
    month_days = [{"date": d.isoformat(), "spent": _spent_between(conn, d, d) if d <= today else None}
                  for d in (first + timedelta(days=i) for i in range(days))]
    return {
        "today": today.isoformat(),
        "day": {"spent": today_spent, "limit": round(day_limit, 2), "mode": mode, "days_left": days_left,
                "left_for_month": round(left_for_month, 2), "pace": round(pace_daily, 2) if pace_daily else None,
                "finish": round(finish, 2)},
        "week": {"spent": week_spent, "limit": round(per_day * 7, 2), "daily_limit": round(per_day, 2),
                 "start": monday.isoformat(), "days": week_days},
        "month": {"key": month, "spent": month_spent, "limit": round(monthly, 2), "goal": goal, "days_left": days_left - 1,
                  "daily_limit": round(per_day, 2), "days": month_days},
        "suggest_limit": suggest,
    }


# ---------- service level (Period -> Group -> Service -> Transactions) ----------

def _service_rows(conn, category: str, name: str, start: str | None = None, end: str | None = None) -> list:
    where, args = ["t.category = ?", "t.currency = 'EUR'", "t.duplicate_of IS NULL", "t.commitment_id IS NULL"], [category]
    if start:
        where.append("t.date >= ?"); args.append(start)
    if end:
        where.append("t.date < ?"); args.append(end)
    rows = conn.execute(f"""
        SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
        JOIN accounts a ON a.id = t.account WHERE {' AND '.join(where)}
    """, args).fetchall()
    return [r for r in rows if service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"]) == name]


def service_detail(conn, category: str, name: str, month: str) -> dict:
    start, end = month_bounds(month)
    rows = _service_rows(conn, category, name, start, end)
    spent = round(-sum(r["amount"] for r in rows), 2)
    count = sum(1 for r in rows if r["amount"] < 0)
    category_total = conn.execute("""SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
        AND category = ? AND currency = 'EUR' AND duplicate_of IS NULL AND commitment_id IS NULL""", (start, end, category)).fetchone()[0]
    weekdays = [0.0] * 7
    per_day = defaultdict(int)
    for r in rows:
        d = date.fromisoformat(r["date"])
        weekdays[d.weekday()] += -r["amount"]
        if r["amount"] < 0:
            per_day[r["date"]] += 1
    busiest = sorted(((n, d) for d, n in per_day.items() if n >= 3), reverse=True)[:2]
    first = month_bounds(shift(month, -5))[0]
    hist_rows = _service_rows(conn, category, name, first, end)
    history = []
    for i in range(5, -1, -1):
        m = shift(month, -i)
        history.append({"month": m, "spent": round(-sum(r["amount"] for r in hist_rows if r["date"].startswith(m)), 2)})
    return {
        "category": category, "name": name, "month": month, "spent": spent, "count": count,
        "average": round(spent / count, 2) if count else 0,
        "share": round(spent / category_total, 3) if category_total > 0 else None,
        "history": history, "weekdays": [round(v, 2) for v in weekdays],
        "busiest_days": [{"date": d, "count": n} for n, d in sorted(busiest, key=lambda x: x[1])],
    }


def service_transaction_ids(conn, category: str, name: str) -> list[str]:
    return [r["id"] for r in _service_rows(conn, category, name)]


# ---------- commitments: fixed and chosen costs, kept apart from free spending ----------

def _commitment_rows(conn) -> list[dict]:
    out = []
    for r in conn.execute("SELECT * FROM commitments ORDER BY kind, name"):
        c = dict(r)
        c["services"] = json.loads(c["services"])
        if c["every_months"] > 1:
            c.update(_cycle(c))
        out.append(c)
    return out


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y += d.year
    m += 1
    days = (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)).day
    return date(y, m, min(d.day, days))


def _cycle(c: dict) -> dict:
    """For a cost paid every few months: the next payment (moved on once its date has passed),
    and what should be put aside towards it by now, a monthly share at a time since the last one."""
    today = local_today()
    nxt = date.fromisoformat(c["next_date"]) if c["next_date"] else _add_months(today, c["every_months"])
    while nxt < today:
        nxt = _add_months(nxt, c["every_months"])
    last = _add_months(nxt, -c["every_months"])
    whole = (today.year - last.year) * 12 + today.month - last.month - (today.day < last.day)
    months = max(0, min(c["every_months"], whole))
    amount = c["amount"] or c["monthly_limit"] * c["every_months"]
    return {"next_date": nxt.isoformat(), "last_date": last.isoformat(), "amount": amount,
            "set_aside": round(min(amount, c["monthly_limit"] * months), 2)}


def committed_total(conn) -> float:
    """Monthly limits of all commitments: what the plan sets aside before free spending."""
    return round(sum(c["monthly_limit"] for c in _commitment_rows(conn)), 2)


def assign_commitments(conn):
    """Tags each transaction with the commitment its service belongs to (or none)."""
    by_service = {s: c["id"] for c in _commitment_rows(conn) for s in c["services"]}
    conn.execute("UPDATE transactions SET commitment_id = NULL WHERE commitment_id IS NOT NULL")
    if not by_service:
        return
    for r in conn.execute("""SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                             JOIN accounts a ON a.id = t.account WHERE t.amount < 0 OR t.amount > 0""").fetchall():
        cid = by_service.get(service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"]))
        if cid:
            conn.execute("UPDATE transactions SET commitment_id = ? WHERE id = ?", (cid, r["id"]))


def _committed_spent(conn, cid: int, start: str, end: str) -> float:
    row = conn.execute(f"SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND {COMMITTED_SQL}",
                       (cid, start, end)).fetchone()
    return round(row[0], 2)


def commitments_view(conn, month: str) -> dict:
    start, end = month_bounds(month)
    items = []
    for c in _commitment_rows(conn):
        spent = _committed_spent(conn, c["id"], start, end) + c["off_bank"]
        history = []
        for i in range(5, -1, -1):
            m = shift(month, -i)
            ms, me = month_bounds(m)
            history.append({"month": m, "spent": round(_committed_spent(conn, c["id"], ms, me) + c["off_bank"], 2)})
        count = conn.execute(f"SELECT COUNT(*) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND amount < 0 AND {COMMITTED_SQL}",
                             (c["id"], start, end)).fetchone()[0]
        # A cost paid every few months is over only when a payment goes past its amount, not its monthly share.
        cap = c["amount"] if c["every_months"] > 1 else c["monthly_limit"]
        items.append({**c, "spent": round(spent, 2), "count": count, "over": spent > cap + 0.005, "history": history})
    taken = {s for c in items for s in c["services"]}
    suggestions = {}
    for s in subscriptions(conn)["items"]:
        if not s["stale"] and s["name"] not in taken:
            suggestions[s["name"]] = s["monthly"]
    seen = services_seen(conn)
    for s in seen:
        if (s["months"] >= 4 and s["category"] in COMMITTABLE and s["monthly"] >= 10
                and not s["service"].startswith("Card · ") and s["service"] not in taken):
            # services_seen averages over 6 months; use the typical active month instead
            suggestions.setdefault(s["service"], round(s["monthly"] * 6 / s["months"], 2))
    suggestions = [{"service": n, "monthly": m, "limit": float(max(10, -(-m * 1.1 // 10) * 10))}
                   for n, m in sorted(suggestions.items(), key=lambda kv: -kv[1]) if m >= 2]
    return {
        "month": month, "items": items, "suggestions": suggestions,
        "limit": round(sum(c["monthly_limit"] for c in items), 2),
        "spent": round(sum(c["spent"] for c in items), 2),
        "over": [c["name"] for c in items if c["over"]],
    }


def services_seen(conn, months: int = 6, transfers: bool = False) -> list[dict]:
    """Every service with spending in the last months, for picking what a commitment covers.
    transfers: also big transfers, since rent paid ahead usually leaves as one."""
    since = month_bounds(shift(this_month(), -months))[0]
    totals = defaultdict(lambda: {"amount": 0.0, "months": set(), "cats": defaultdict(int)})
    for r in conn.execute("""SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
        JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.amount < 0 AND t.duplicate_of IS NULL AND t.currency = 'EUR'
          AND (t.category NOT IN ('transfer', 'card_payment', 'income') OR (? AND t.category = 'transfer' AND t.amount <= -300))""",
                         (since, transfers)):
        n = service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])
        totals[n]["amount"] -= r["amount"]
        totals[n]["months"].add(month_of(r["date"]))
        totals[n]["cats"][r["category"]] += 1
    return sorted(({"service": n, "monthly": round(v["amount"] / months, 2), "months": len(v["months"]),
                    "category": max(v["cats"], key=v["cats"].get)}
                   for n, v in totals.items() if v["amount"] > 0), key=lambda x: -x["monthly"])


# Habits stay out of suggestions: those are what the plan is for, not commitments.
COMMITTABLE = {"bills", "subscriptions", "health", "housing", "eating_out", "leisure", "personal_care", "pets", "fees",
               "loans", "insurance", "education", "kids"}


# ---------- cash entries: spending logged by hand, taken out of withdrawals ----------

CASH_ACCOUNT = "cash"


def cash_view(conn, month: str) -> dict:
    """Withdrawn this month vs what has been logged against it."""
    start, end = month_bounds(month)
    withdrawn = -conn.execute("""SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
        AND category = 'cash' AND account != ? AND amount < 0 AND duplicate_of IS NULL AND currency = 'EUR'""",
                              (start, end, CASH_ACCOUNT)).fetchone()[0]
    logged = -conn.execute("""SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
        AND account = ? AND status = 'CASH' AND amount < 0""", (start, end, CASH_ACCOUNT)).fetchone()[0]
    return {"withdrawn": round(withdrawn, 2), "logged": round(logged, 2), "unaccounted": round(max(0, withdrawn - logged), 2)}


def log_cash(conn, amount: float, category: str, note: str, day: str) -> str:
    """Records cash spending. Two rows: the spending in its category, and an equal credit in Cash, so the
    withdrawal (already counted as Cash) shrinks by the same amount and the month's total doesn't change."""
    import uuid as _uuid
    conn.execute("""INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, NULL, 'Cash', 0, NULL, 'Cash')
                    ON CONFLICT(user_id, id) DO NOTHING""", (CASH_ACCOUNT,))
    key = _uuid.uuid4().hex[:12]
    note = note.strip() or CATEGORIES[category][0]
    raw = json.dumps({"logged_by_hand": True, "note": note})
    conn.execute("""INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
                    VALUES(?, ?, ?, ?, 'EUR', 'CASH', ?, ?, NULL, ?, ?)""",
                 (f"cash:{key}", CASH_ACCOUNT, day, -abs(amount), f"Cash: {note}", f"Cash: {note}", category, raw))
    # The offset never shows in lists (status OFFSET); it only reduces Cash.
    conn.execute("""INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw, duplicate_of)
                    VALUES(?, ?, ?, ?, 'EUR', 'OFFSET', ?, '', NULL, 'cash', ?, NULL)""",
                 (f"cash:{key}:offset", CASH_ACCOUNT, day, abs(amount), f"Logged from cash: {note}", raw))
    return f"cash:{key}"


# ---------- questions the assistant asks: payments it couldn't place ----------

def questions(conn, limit: int = 10) -> list[dict]:
    """One question per payee left in Other over the last 90 days, biggest first."""
    since = (local_today() - timedelta(days=90)).isoformat()
    rows = conn.execute("""SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card, a.name AS account
        FROM transactions t JOIN accounts a ON a.id = t.account
        WHERE t.category = 'other' AND t.amount < 0 AND t.date >= ? AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
          AND t.status != 'OFFSET' ORDER BY t.amount""", (since,)).fetchall()
    out = {}
    for r in rows:
        n = service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])
        q = out.setdefault(n, {"service": n, "tx_id": r["id"], "count": 0, "amount": 0.0, "date": r["date"],
                               "account": r["account"], "has_merchant": bool(r["merchant"])})
        q["count"] += 1
        q["amount"] = round(q["amount"] - r["amount"], 2)
    return sorted(out.values(), key=lambda q: -q["amount"])[:limit]


def service_ids_anywhere(conn, name: str) -> list:
    rows = conn.execute("""SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                           JOIN accounts a ON a.id = t.account WHERE t.status != 'OFFSET'""").fetchall()
    return [r for r in rows if service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"]) == name]


def set_service_category(conn, name: str, category: str) -> int:
    """All payments to a service go to category, now and in future (rules keyed by merchant)."""
    rows = service_ids_anywhere(conn, name)
    for r in rows:
        key = r["merchant"] or f"tx:{r['id']}"
        conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
                     (key, category))
    db.recategorize(conn)
    return len(rows)


def clear_service_category(conn, name: str) -> int:
    """Undo set_service_category: drop the service's rules so its payments go back to being worked out."""
    rows = service_ids_anywhere(conn, name)
    for r in rows:
        conn.execute("DELETE FROM rules WHERE merchant = ?", (r["merchant"] or f"tx:{r['id']}",))
    db.recategorize(conn)
    return len(rows)


# ---------- extra pay: the Easter, summer and Christmas bonuses of 14 salaries a year ----------

def _orthodox_easter(y: int) -> date:
    """Greek Easter: the Julian computus, moved to the Gregorian calendar (13 days, 1900-2099)."""
    a, b, c = y % 4, y % 7, y % 19
    d = (19 * c + 15) % 30
    e = (2 * a + 4 * b - d + 34) % 7
    month, day = divmod(d + e + 114, 31)
    return date(y, month, day + 1) + timedelta(days=13)


def extra_pay(conn) -> list[dict]:
    """The next three bonuses, soonest first, when 14 salaries is on. Rough amounts from your pay:
    a month at Christmas, half a month at Easter and in summer. The monthly budget doesn't count on them."""
    if not (db.get_meta(conn, "settings") or {}).get("extra_pay"):
        return []
    plan = get_plan(conn)
    pay = plan["take_home"] if plan else 0
    today = local_today()
    out = []
    for y in (today.year, today.year + 1):
        out += [
            {"name": "Easter bonus", "amount": round(pay / 2), "date": (_orthodox_easter(y) - timedelta(days=4)).isoformat(), "when": "before Easter"},
            {"name": "Summer bonus", "amount": round(pay / 2), "date": date(y, 6, 30).isoformat(), "when": "usually by the end of June"},
            {"name": "Christmas bonus", "amount": round(pay), "date": date(y, 12, 21).isoformat(), "when": "by 21 December"},
        ]
    out = sorted((b for b in out if b["date"] >= today.isoformat()), key=lambda b: b["date"])[:3]
    for b in out:
        d = date.fromisoformat(b["date"])
        day = f"{d.day} {d.strftime('%B')}" + (f" {d.year}" if d.year != today.year else "")
        b["when"] = {"before Easter": f"By {day}, before Easter", "by 21 December": f"By {day}"}.get(b["when"], f"Usually by {day}")
    return out

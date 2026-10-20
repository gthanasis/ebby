"""The Spending tab: any day, week, pay month or year, what happened in it, and how it compares.

Everything is worked out from one set of rows per period (free spending, the same rows Today uses),
so the total, the chart, the categories and the highlights always agree. "Usual" is the median of
the periods before, cut to the same number of days while the period is still going, so a
half-finished month is compared with half-finished months.
"""

import statistics
from datetime import date, timedelta

from app.domain import insights
from app.domain.insights import SPEND_ARGS, SPEND_SQL

RANGES = ("day", "week", "month", "year")
USUAL_COUNT = {"day": 8, "week": 8, "month": 6}
# How often matters for these, so their counts are worth saying.
HABITS = {"delivery", "eating_out", "coffee_bars", "people", "groceries"}
# A drop here is usually timing (not charged yet), not something you did.
TIMED = {"bills", "health", "car", "subscriptions", "pets", "insurance", "loans", "education"}
_T = SPEND_SQL
for _col in ("duplicate_of", "commitment_id", "currency", "category IN"):
    _T = _T.replace(_col, "t." + _col)


def _median(values: list[float]) -> float:
    return float(statistics.median(values)) if values else 0.0


def bounds(rng: str, off: int) -> tuple[date, date, str]:
    """(first day, last day, key) of the period `off` steps from the current one."""
    today = insights.local_today()
    if rng == "day":
        d = today + timedelta(days=off)
        return d, d, d.isoformat()
    if rng == "week":
        monday = today - timedelta(days=today.weekday()) + timedelta(weeks=off)
        return monday, monday + timedelta(days=6), monday.isoformat()
    if rng == "month":
        key = insights.shift(insights.this_month(), off)
        a, b = insights.month_bounds(key)
        return date.fromisoformat(a), date.fromisoformat(b) - timedelta(days=1), key
    y = int(insights.this_month()[:4]) + off
    return (date.fromisoformat(insights.month_bounds(f"{y}-01")[0]),
            date.fromisoformat(insights.month_bounds(f"{y}-12")[1]) - timedelta(days=1), str(y))


def _rows(conn, a: date, b: date) -> list[dict]:
    """Free spending between two days, each with the service it went to."""
    out = []
    for r in conn.execute(f"""SELECT t.date, -t.amount AS amount, t.category, t.merchant, t.description, t.mcc, a.is_card
            FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.date <= ? AND {_T}
            ORDER BY t.date, t.amount""", (a.isoformat(), b.isoformat(), *SPEND_ARGS)):
        out.append({"date": r["date"], "amount": round(r["amount"], 2), "category": r["category"],
                    "name": insights.service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])})
    return out


def _total(rows) -> float:
    return round(sum(r["amount"] for r in rows), 2)


def _by_category(rows) -> dict[str, list]:
    out: dict[str, list] = {}
    for r in rows:
        c = out.setdefault(r["category"], [0.0, 0])
        c[0] += r["amount"]
        c[1] += 1
    return out


def _first_day(conn) -> date | None:
    row = conn.execute("SELECT MIN(date) FROM transactions").fetchone()[0]
    return date.fromisoformat(row) if row else None


def _past(conn, rng: str, off: int, count: int, days: int | None) -> list[list[dict]]:
    """The periods before this one, each cut to `days` days when given; stops where data starts."""
    first = _first_day(conn)
    out = []
    for k in range(1, count + 1):
        a, b, _ = bounds(rng, off - k)
        if not first or a < first:
            break
        out.append(_rows(conn, a, a + timedelta(days=days - 1) if days else b))
    return out


def _usual(past: list[list[dict]]) -> tuple[float | None, dict[str, list[float]]]:
    """Usual total and, per category, usual money and usual count."""
    if not past:
        return None, {}
    maps = [_by_category(p) for p in past]
    cats = {c for m in maps for c in m}
    per = {c: [_median([m.get(c, [0, 0])[0] for m in maps]), _median([m.get(c, [0, 0])[1] for m in maps])] for c in cats}
    return round(_median([_total(p) for p in past]), 2), per


def _highlights(rows, usual_cats, days, elapsed, rng, min_move) -> list[dict]:
    now = _by_category(rows)
    moves = []
    for c in sorted(set(now) | set(usual_cats)):  # sorted: equal moves keep one order
        v, n = now.get(c, [0.0, 0])
        ua, uc = usual_cats.get(c, [0.0, 0.0])
        d = v - ua
        if abs(d) >= min_move and not (d < 0 and c in TIMED):
            moves.append({"kind": "category", "category": c, "spent": round(v, 2), "usual": round(ua, 2), "count": n,
                          "usual_count": round(uc) if c in HABITS else None})
    ups = sorted((m for m in moves if m["spent"] > m["usual"]), key=lambda m: m["usual"] - m["spent"])
    downs = sorted((m for m in moves if m["spent"] < m["usual"]), key=lambda m: m["spent"] - m["usual"])
    out = (ups[:2] + downs[:1] + ups[2:])[:3]
    total = _total(rows)
    big = max(rows, key=lambda r: r["amount"], default=None)
    if big and big["amount"] >= total * (0.12 if rng == "week" else 0.08):
        out.append({"kind": "payment", **big})
    if rng == "month" and elapsed >= 14:
        sums, counts = [0.0] * 7, [0] * 7
        for d in days:
            if d["spent"] is not None:
                wd = date.fromisoformat(d["date"]).weekday()
                sums[wd] += d["spent"]
                counts[wd] += 1
        avg = [s / c if c else 0 for s, c in zip(sums, counts)]
        top = max(range(7), key=lambda i: avg[i])
        overall = total / elapsed if elapsed else 0
        if overall and avg[top] > overall * 1.6:
            out.append({"kind": "weekday", "weekday": top, "average": round(avg[top], 2), "overall": round(overall, 2)})
    none = sum(1 for d in days if d["spent"] == 0)
    out.append({"kind": "nospend", "days": none, "of": elapsed})
    return out


def _payments(rows, limit: int | None = None) -> list[dict]:
    rows = sorted(rows, key=lambda r: (r["date"], r["amount"]), reverse=True)
    return rows[:limit] if limit else rows


def view(conn, rng: str, off: int) -> dict:
    today = insights.local_today()
    a, b, key = bounds(rng, off)
    upto = min(b, today)
    rows = _rows(conn, a, upto) if a <= today else []
    total = _total(rows)
    partial = b > today
    elapsed = max(0, (upto - a).days + 1)
    first = _first_day(conn)
    out = {
        "range": rng, "off": off, "key": key, "start": a.isoformat(), "end": b.isoformat(), "today": today.isoformat(),
        "partial": partial, "elapsed": elapsed, "length": (b - a).days + 1, "total": total, "count": len(rows),
        "can_prev": bool(first and bounds(rng, off - 1)[1] >= first),
        "can_next": off < 0,
    }
    if rng == "year":
        return {**out, **_year(conn, int(key), rows, total)}

    days = [{"date": d.isoformat(), "spent": round(sum(r["amount"] for r in rows if r["date"] == d.isoformat()), 2) if d <= today else None}
            for d in (a + timedelta(days=i) for i in range((b - a).days + 1))]
    if rng == "day":
        # The week the day sits in, and what this weekday usually comes to.
        monday = a - timedelta(days=a.weekday())
        week_rows = _rows(conn, monday, min(monday + timedelta(days=6), today))
        week = [{"date": d.isoformat(), "spent": round(sum(r["amount"] for r in week_rows if r["date"] == d.isoformat()), 2) if d <= today else None}
                for d in (monday + timedelta(days=i) for i in range(7))]
        usual = _median([_total(_rows(conn, a - timedelta(weeks=k), a - timedelta(weeks=k))) for k in range(1, 9)])
        return {**out, "week": week, "usual": round(usual, 2), "payments": _payments(rows)}

    count = USUAL_COUNT[rng]
    last = _past(conn, rng, off, 1, elapsed if partial else None)
    usual_total, usual_cats = _usual(_past(conn, rng, off, count, elapsed if partial else None))
    full_usual, _ = _usual(_past(conn, rng, off, count, None))
    trend = []
    for k in range(7 if rng == "week" else 11, -1, -1):
        ta, tb, tkey = bounds(rng, off - k)
        if first and ta < first - timedelta(days=31):
            continue
        trend.append({"off": off - k, "key": tkey, "start": ta.isoformat(), "total": _total(_rows(conn, ta, min(tb, today)))})
    return {
        **out, "days": days, "trend": trend, "usual_full": full_usual,
        "last": _total(last[0]) if last else None, "last_key": bounds(rng, off - 1)[2], "usual": usual_total,
        "categories": sorted(({"category": c, "spent": round(v, 2), "count": n, "usual": round(usual_cats.get(c, [0])[0], 2)}
                              for c, (v, n) in _by_category(rows).items()), key=lambda c: -c["spent"]),
        "highlights": _highlights(rows, usual_cats, days, elapsed, rng, 20 if rng == "week" else 40),
        "payments": _payments(rows),
    }


def _year(conn, year: int, rows, total) -> dict:
    today = insights.local_today()
    months = []
    for m in range(1, 13):
        key = f"{year}-{m:02d}"
        ma, mb = (date.fromisoformat(x) for x in insights.month_bounds(key))
        if ma > today:
            months.append({"key": key, "total": None, "done": False})
            continue
        mrows = [r for r in rows if ma.isoformat() <= r["date"] < mb.isoformat()]
        months.append({"key": key, "total": _total(mrows), "done": mb <= today, "rows": mrows})
    # The same usual month as the Month view: the median of the last six finished months.
    usual, _ = _usual(_past(conn, "month", 0, 6, None))
    usual = usual or 0
    done = [m for m in months if m["done"]]
    highlights = []
    standout = max(done, key=lambda m: m["total"], default=None)
    if standout and usual and standout["total"] > usual * 1.5:
        lead = max(_by_category(standout["rows"]).items(), key=lambda kv: kv[1][0])
        highlights.append({"kind": "month", "month": standout["key"], "total": standout["total"], "usual": usual,
                           "category": lead[0], "amount": round(lead[1][0], 2)})
    else:
        standout = None
    # How each category moved: the last three finished months against the three before.
    if len(done) >= 6:
        def avg(ms):
            t: dict[str, float] = {}
            for m in ms:
                for c, (v, _) in _by_category(m["rows"]).items():
                    t[c] = t.get(c, 0) + v / len(ms)
            return t
        before, after = avg(done[-6:-3]), avg(done[-3:])
        moves = [(c, max(0.0, before.get(c, 0)), max(0.0, after.get(c, 0))) for c in sorted(set(before) | set(after))]
        for c, x, y in sorted((m for m in moves if abs(m[2] - m[1]) >= 60), key=lambda m: -abs(m[2] - m[1]))[:3]:
            highlights.append({"kind": "trend", "category": c, "before": round(x, 2), "after": round(y, 2),
                               "from": done[-3]["key"], "to": done[-1]["key"]})
    big = max(rows, key=lambda r: r["amount"], default=None)
    if big and not (standout and big in standout["rows"]):
        highlights.append({"kind": "payment", **big})
    heavy = [m["key"] for m in done if usual and m["total"] > usual * 1.25 and (not standout or m["key"] != standout["key"])]
    if heavy:
        highlights.append({"kind": "heavy_months", "months": heavy, "of": len(done)})
    started = [m for m in months if m["total"] is not None]
    return {
        "months": [{k: v for k, v in m.items() if k != "rows"} for m in months], "usual": round(usual, 2),
        "categories": sorted(({"category": c, "spent": round(v, 2), "count": n, "per_month": round(v / max(1, len(started)), 2)}
                              for c, (v, n) in _by_category(rows).items()), key=lambda c: -c["spent"]),
        "highlights": highlights, "payments": _payments(sorted(rows, key=lambda r: -r["amount"])[:15]),
    }


def category(conn, cat: str, rng: str, off: int) -> dict:
    """One category over a period: its total, its usual month, six months of history, and who got it."""
    today = insights.local_today()
    a, b, key = bounds(rng, off)
    rows = [r for r in _rows(conn, a, min(b, today)) if r["category"] == cat] if a <= today else []
    services: dict[str, list] = {}
    for r in rows:
        s = services.setdefault(r["name"], [0.0, 0])
        s[0] += r["amount"]
        s[1] += 1
    history = []
    month = insights.month_of(min(b, today))
    for k in range(5, -1, -1):
        m = insights.shift(month, -k)
        ma, mb = (date.fromisoformat(x) for x in insights.month_bounds(m))
        history.append({"key": m, "total": _total([r for r in _rows(conn, ma, min(mb - timedelta(days=1), today)) if r["category"] == cat])})
    return {
        "category": cat, "range": rng, "off": off, "key": key, "start": a.isoformat(), "end": b.isoformat(), "month": month,
        "total": _total(rows), "count": len(rows), "usual_month": round(_median([h["total"] for h in history[:-1]]), 2),
        "history": history,
        "services": sorted(({"name": n, "spent": round(v, 2), "count": c} for n, (v, c) in services.items()), key=lambda s: -s["spent"]),
    }


def context(conn, rng: str, off: int) -> str:
    """What Claude reads to explain a period: the numbers above and every payment in it."""
    v = view(conn, rng, off)
    lines = [f"Period: {rng} from {v['start']} to {v['end']}" + (f" (still going, {v['elapsed']} of {v['length']} days so far)" if v["partial"] else "") + ".",
             f"Free spending in it: €{v['total']:,.0f} over {v['count']} payments."]
    if rng != "year":
        if v.get("last") is not None:
            lines.append(f"The period before, {'to the same point' if v['partial'] else 'in full'}: €{v['last']:,.0f}.")
        if v.get("usual") is not None:
            lines.append(f"A usual {rng}{' by this point' if v['partial'] else ''} (median of the ones before): €{v['usual']:,.0f}.")
        if rng != "day":
            lines.append("By category (spent / usual / payments): " + "; ".join(
                f"{c['category']} €{c['spent']:,.0f} / €{c['usual']:,.0f} / {c['count']}" for c in v["categories"]))
    else:
        lines.append(f"A usual month: €{v['usual']:,.0f}. Months: " + ", ".join(
            f"{m['key']} €{m['total']:,.0f}" for m in v["months"] if m["total"] is not None))
        lines.append("By category (spent / per month): " + "; ".join(f"{c['category']} €{c['spent']:,.0f} / €{c['per_month']:,.0f}" for c in v["categories"]))
    pays = v["payments"] if rng != "year" else _payments(_rows(conn, date.fromisoformat(v["start"]), min(date.fromisoformat(v["end"]), insights.local_today())))
    lines.append(f"\nPayments (date, amount, category, service){' - the 400 most recent' if len(pays) > 400 else ''}:")
    lines += [f"{p['date']}, €{p['amount']:.2f}, {p['category']}, {p['name']}" for p in pays[:400]]
    return "\n".join(lines)

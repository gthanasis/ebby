"""Categories, the month's overview, the transaction list, and moving a payment to another category."""

from datetime import date, timedelta

from fastapi import HTTPException

from pydantic import BaseModel


from app.domain import insights
from app.data import db
from app.domain.categories import CATEGORIES
from fastapi import APIRouter


router = APIRouter()
# Totals only add up euros; rows in other currencies (Revolut pockets) still show in the list.
SPEND_SQL, SPEND_ARGS = insights.SPEND_SQL, insights.SPEND_ARGS


def _month(month: str | None) -> tuple[str, str, str]:
    """(YYYY-MM, first day, first day of the next month) of a pay month."""
    key = month or insights.this_month()
    return (key, *insights.month_bounds(key))


_shift = insights.shift


def _spent(conn, start: str, end: str) -> float:
    row = conn.execute(f"SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND {SPEND_SQL}",
                       (start, end, *SPEND_ARGS)).fetchone()
    return round(row[0], 2)


@router.get("/api/categories")
def categories():
    return [{"id": k, "label": label, "icon": icon, "spending": spend} for k, (label, icon, spend) in CATEGORIES.items()]


@router.get("/api/overview")
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


@router.get("/api/transactions")
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


@router.put("/api/transactions/{tx_id:path}/category")
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

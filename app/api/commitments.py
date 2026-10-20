"""Commitments: fixed and chosen costs, kept apart from free spending."""

from datetime import date

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.data import db
from app.domain import insights

router = APIRouter()


class CommitmentIn(BaseModel):
    name: str
    kind: str = "chosen"
    monthly_limit: float
    note: str = ""
    services: list[str] = []
    off_bank: float = 0
    every_months: int = 1          # 1, 3, 6 or 12
    amount: float | None = None    # each time, for costs paid every few months
    next_date: str | None = None


def _check_commitment(body: CommitmentIn):
    if body.every_months not in (1, 3, 6, 12):
        raise HTTPException(400, "How often is every 1, 3, 6 or 12 months")
    if body.every_months > 1:
        # The budget sets aside a monthly share of a cost paid every few months.
        if not body.amount or body.amount <= 0:
            raise HTTPException(400, "A cost paid every few months needs the amount you pay each time")
        try:
            date.fromisoformat(body.next_date or "")
        except ValueError:
            raise HTTPException(400, "A cost paid every few months needs the date of its next payment")
        body.monthly_limit = round(body.amount / body.every_months, 2)
    else:
        body.amount = body.next_date = None
    if not body.name.strip() or body.monthly_limit <= 0 or body.kind not in ("fixed", "chosen"):
        raise HTTPException(400, "A commitment needs a name, a limit above zero, and kind fixed or chosen")
    if not body.services and body.off_bank <= 0 and body.every_months == 1:
        raise HTTPException(400, "Pick the payments it covers, or the amount you pay outside your accounts")


@router.get("/api/commitments")
def commitments(month: str | None = None):
    with db.connect() as conn:
        return insights.commitments_view(conn, month or insights.this_month())


@router.get("/api/commitments/services")
def commitment_services(transfers: bool = False):
    """Services to pick from when creating a commitment; with transfers, big transfers over 13 months too."""
    with db.connect() as conn:
        return insights.services_seen(conn, 13, True) if transfers else insights.services_seen(conn)


@router.post("/api/commitments")
def add_commitment(body: CommitmentIn):
    _check_commitment(body)
    import json as _json
    from datetime import datetime, timezone
    with db.connect() as conn:
        conn.execute("""INSERT INTO commitments(name, kind, monthly_limit, note, services, off_bank, created_at, every_months, amount, next_date)
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                     (body.name.strip(), body.kind, body.monthly_limit, body.note.strip(), _json.dumps(body.services),
                      max(0, body.off_bank), datetime.now(timezone.utc).isoformat(), body.every_months, body.amount, body.next_date))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())


@router.put("/api/commitments/{cid}")
def edit_commitment(cid: int, body: CommitmentIn):
    _check_commitment(body)
    import json as _json
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM commitments WHERE id = ?", (cid,)).fetchone():
            raise HTTPException(404, "No such commitment")
        conn.execute("""UPDATE commitments SET name = ?, kind = ?, monthly_limit = ?, note = ?, services = ?, off_bank = ?,
                        every_months = ?, amount = ?, next_date = ? WHERE id = ?""",
                     (body.name.strip(), body.kind, body.monthly_limit, body.note.strip(), _json.dumps(body.services), max(0, body.off_bank),
                      body.every_months, body.amount, body.next_date, cid))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())


@router.delete("/api/commitments/{cid}")
def delete_commitment(cid: int):
    with db.connect() as conn:
        conn.execute("DELETE FROM commitments WHERE id = ?", (cid,))
        insights.assign_commitments(conn)
        insights.resplit(conn)
        return insights.commitments_view(conn, insights.this_month())

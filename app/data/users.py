"""People: the allow list, sign-in sessions, and the admin's view of them.

These tables have no row-level security (they're how a request finds its user), so everything
here runs through db.connect_system() and never touches anyone's own rows.
"""

from datetime import datetime, timedelta, timezone

from app.data import db
from app import clock


class Store:
    """auth.AuthStore on Postgres."""

    def user_by_email(self, email: str) -> dict | None:
        return db.user_by_email(email)

    def activate(self, user_id, name, picture):
        with db.connect_system() as conn:
            conn.execute("UPDATE users SET status = 'active', name = ?, picture = ? WHERE id = ? AND status = 'invited'",
                         (name, picture, user_id))

    def create_session(self, user_id, token_hash, expires_at, user_agent):
        with db.connect_system() as conn:
            conn.execute("INSERT INTO sessions(token_hash, user_id, expires_at, user_agent) VALUES(?, ?, ?, ?)",
                         (token_hash, user_id, expires_at, user_agent))
            conn.execute("UPDATE users SET last_login_at = now() WHERE id = ?", (user_id,))
            conn.execute("DELETE FROM sessions WHERE expires_at < now()")

    def session_user(self, token_hash):
        with db.connect_system() as conn:
            row = conn.execute("""
                SELECT u.id, u.email, u.name, u.picture, u.status, u.is_admin, s.extended_at FROM sessions s
                JOIN users u ON u.id = s.user_id
                WHERE s.token_hash = ? AND s.expires_at > now() AND u.status = 'active'
            """, (token_hash,)).fetchone()
            if not row:
                return None
            if row["extended_at"] < clock.now() - timedelta(days=1):
                conn.execute("UPDATE sessions SET expires_at = now() + interval '30 days', extended_at = now() WHERE token_hash = ?",
                             (token_hash,))
        return {k: v for k, v in row.items() if k != "extended_at"}

    def delete_session(self, token_hash):
        with db.connect_system() as conn:
            conn.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))


def me(user_id: int) -> dict:
    with db.connect_system() as conn:
        row = conn.execute("SELECT id, email, name, picture, is_admin, status, ai_budget_usd FROM users WHERE id = ?",
                           (user_id,)).fetchone()
    return dict(row)


def people(since: datetime) -> list[dict]:
    """The admin's list: everyone on it and what they spent on AI since `since`. No one's own data."""
    with db.connect_system() as conn:
        spent = {r["user_id"]: r["cost_usd"] for r in conn.execute("SELECT * FROM admin_ai_usage(?)", (since,))}
        rows = conn.execute("""SELECT id, email, name, picture, is_admin, status, ai_budget_usd, created_at, last_login_at
                               FROM users ORDER BY created_at""").fetchall()
    return [{**dict(r), "ai_spent_usd": round(spent.get(r["id"], 0.0), 2)} for r in rows]


def invite(email: str, ai_budget_usd: float | None = None) -> dict:
    email = email.strip().lower()
    if "@" not in email:
        raise ValueError("That isn't an email address.")
    with db.connect_system() as conn:
        row = conn.execute("""
            INSERT INTO users(email, ai_budget_usd, created_at) VALUES(?, COALESCE(?, 2), ?) ON CONFLICT(email) DO NOTHING
            RETURNING id
        """, (email, ai_budget_usd, clock.now())).fetchone()
    if not row:
        raise ValueError(f"{email} is already on the list.")
    return me(row["id"])


def update(user_id: int, *, status: str | None = None, ai_budget_usd: float | None = None):
    with db.connect_system() as conn:
        if status is not None:
            conn.execute("UPDATE users SET status = ? WHERE id = ? AND NOT is_admin", (status, user_id))
            if status == "disabled":
                conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))  # out at once, not at expiry
        if ai_budget_usd is not None:
            conn.execute("UPDATE users SET ai_budget_usd = ? WHERE id = ?", (ai_budget_usd, user_id))

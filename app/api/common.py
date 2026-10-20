"""What several route modules read the same way."""

from app import config
from app.data import db
from app.domain import insights


def settings(conn) -> dict:
    model = next((k for k, v in config.ASSISTANT_MODELS.items() if v == config.ASSISTANT_MODEL), "haiku")
    return {"alerts": True, "weekly_read": True, "assistant_model": model, **(db.get_meta(conn, "settings") or {})}


def goals(conn) -> list[dict]:
    return [insights.goal_view(conn, dict(r)) for r in conn.execute("SELECT * FROM goals ORDER BY target_date")]

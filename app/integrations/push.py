"""Web push to the installed app (iPhone needs it on the home screen, iOS 16.4+)."""

import base64
import json
import logging
from datetime import datetime, timezone

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

from app import config
from app.data import db

log = logging.getLogger("bank-sync")
_KEY_FILE = config.DATA_DIR / "vapid.pem"


def _vapid() -> Vapid:
    if config.VAPID_PRIVATE_KEY:
        return Vapid.from_pem(config.VAPID_PRIVATE_KEY.replace("\\n", "\n").encode())
    if not _KEY_FILE.exists():
        v = Vapid()
        v.generate_keys()
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        v.save_key(str(_KEY_FILE))
        _KEY_FILE.chmod(0o600)
    return Vapid.from_file(str(_KEY_FILE))


def public_key() -> str:
    """The applicationServerKey the browser subscribes with (uncompressed point, base64url)."""
    raw = _vapid().public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def subscribe(subscription: dict):
    with db.connect() as conn:
        conn.execute("""
            INSERT INTO push_subscriptions(endpoint, subscription, created_at) VALUES(?, ?, ?)
            ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription
        """, (subscription["endpoint"], json.dumps(subscription), datetime.now(timezone.utc).isoformat()))


def unsubscribe(endpoint: str):
    with db.connect() as conn:
        conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", (endpoint,))


def count() -> int:
    with db.connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM push_subscriptions").fetchone()[0]


def send(title: str, body: str, url: str = "/", tag: str | None = None) -> int:
    """Sends to every subscribed device; drops subscriptions the push service says are gone."""
    with db.connect() as conn:
        subs = [json.loads(r[0]) for r in conn.execute("SELECT subscription FROM push_subscriptions")]
    if not subs:
        return 0
    vapid = _vapid()
    payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    sent = 0
    for sub in subs:
        try:
            webpush(subscription_info=sub, data=payload, vapid_private_key=vapid,
                    vapid_claims={"sub": config.VAPID_SUBJECT}, ttl=60 * 60 * 12)
            sent += 1
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                unsubscribe(sub["endpoint"])
            log.warning("push failed (%s): %s", status, e)
    return sent

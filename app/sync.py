import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

from . import banks, config, credentials, db
from .enable_banking import MAX_HISTORY_DAYS, Client, EnableBankingError

log = logging.getLogger("bank-sync")


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def is_syncing() -> bool:
    return db.is_locked(db.LOCK_SYNC, db.current_user())


def start_auth(bank: str) -> str:
    if config.DEMO:
        raise ValueError("This is the demo: banks can't be connected here.")
    info = banks.find(bank)
    if not info:
        raise ValueError(f"{bank} isn't a bank Enable Banking connects in {config.COUNTRY}.")
    state = str(uuid.uuid4())
    url = credentials.client().start_auth(bank, state, min(config.CONSENT_DAYS, info["consent_days"] or config.CONSENT_DAYS))
    with db.connect() as conn:
        db.update_connection(conn, bank, auth_state=state)
    return url


def complete_auth(address: str) -> tuple[str, int]:
    """Finishes authorisation from the address the bank redirected to. Returns (bank, account count)."""
    query = parse_qs(urlparse(address.strip()).query)
    state = query.get("state", [None])[0]
    with db.connect() as conn:
        row = conn.execute("SELECT bank FROM connections WHERE auth_state = ?", (state,)).fetchone() if state else None
    if not row:
        raise ValueError("That address isn't from the latest connection attempt. Start again.")
    if "code" not in query:
        raise ValueError(f"The bank didn't return a code ({query.get('error', ['no details'])[0]}).")
    bank = row["bank"]
    session = credentials.client().create_session(query["code"][0])
    with db.connect() as conn:
        for acc in session.get("accounts", []):
            db.upsert_account(conn, acc, bank)
        # Full history is usually only served in the first hour after authorising, so backfill now.
        db.update_connection(conn, bank, session_id=session["session_id"],
                             valid_until=(session.get("access") or {}).get("valid_until"),
                             auth_state=None, last_error=None, backfill=1)
    db.thread(sync)
    return bank, len(session.get("accounts", []))


LIVE_LOOKBACK_DAYS = 7


def sync(psu: dict | None = None) -> bool:
    """Syncs every connected bank that doesn't need reconnecting. True if all of them succeeded.
    psu: the user's own request headers when they opened the app (a live sync); None for the schedule."""
    # One sync at a time per person, across every pod; different people's banks sync independently.
    with db.advisory_lock(db.LOCK_SYNC, db.current_user()) as mine:
        return _sync_all(psu) if mine else False


def _sync_all(psu: dict | None) -> bool:
    with db.connect() as conn:
        db.set_meta(conn, "last_live_sync" if psu else "last_attempt", now_iso())
        todo = [c for c in db.connections(conn)
                if c["session_id"] and not (c["last_error"] or {}).get("reconnect")]
    if not todo:
        return True
    client = credentials.client()
    return all([_sync_bank(client, c, psu) for c in todo])


def _sync_bank(client: Client, conn_row: dict, psu: dict | None = None) -> bool:
    bank = conn_row["bank"]
    try:
        with db.connect() as conn:
            accounts = [dict(r) for r in conn.execute(
                "SELECT id, uid, is_card FROM accounts WHERE uid IS NOT NULL AND bank = ?", (bank,))]
        if conn_row["backfill"] or not conn_row["last_sync"]:
            days = MAX_HISTORY_DAYS
        else:
            days = LIVE_LOOKBACK_DAYS if psu else config.SYNC_LOOKBACK_DAYS
        changed = 0
        for acc in accounts:
            for start, end, rows in client.transactions(acc["uid"], days, psu):
                with db.connect() as conn:
                    changed += db.save_window(conn, acc["id"], bool(acc["is_card"]), start.isoformat(), end.isoformat(), rows)
            balance = _pick_balance(client.balances(acc["uid"], psu))
            with db.connect() as conn:
                conn.execute("UPDATE accounts SET balance = ?, balance_at = ?, synced_at = ? WHERE id = ?",
                             (balance, now_iso(), now_iso(), acc["id"]))
        with db.connect() as conn:
            pairs = db.dedupe(conn)
            from . import insights
            insights.assign_commitments(conn)  # new rows from this sync
            insights.autofill(conn)  # first import: set the plan up from the transactions
            db.update_connection(conn, bank, last_sync=now_iso(), last_error=None, backfill=0)
        if pairs:
            log.info("%s: %d debit-card purchases paired with their account rows", bank, pairs)
        log.info("%s: sync done, %d rows changed across %d accounts", bank, changed, len(accounts))
        return True
    except EnableBankingError as e:
        log.warning("%s: sync failed: %s", bank, e)
        error = {"at": now_iso(), "code": e.code, "message": e.message, "reconnect": e.session_expired}
    except Exception as e:  # keep the scheduler alive on network hiccups
        log.exception("%s: sync failed", bank)
        error = {"at": now_iso(), "code": type(e).__name__, "message": str(e), "reconnect": False}
    with db.connect() as conn:
        db.update_connection(conn, bank, last_error=error)
    return False


def _pick_balance(balances: list):
    order = ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "OTHR"]
    ranked = sorted(balances, key=lambda b: order.index(b.get("balance_type")) if b.get("balance_type") in order else 99)
    for b in ranked:
        amount = (b.get("balance_amount") or {}).get("amount")
        if amount is not None:
            return float(amount)
    return None


def _weekly_read_due() -> bool:
    """Mondays from 09:00 local time, once per ISO week."""
    from . import ai, alerts
    now = alerts.local_now()
    if not ai.available() or now.weekday() != 0 or now.hour < 9:
        return False
    with db.connect() as conn:
        read = db.get_meta(conn, "weekly_read") or {}
        settings = db.get_meta(conn, "settings") or {}
    if not settings.get("weekly_read", True):
        return False
    made = read.get("created_at")
    return not made or datetime.fromisoformat(made).isocalendar()[:2] != now.isocalendar()[:2]


def run_scheduler():
    """Background loop, for each active person: sync every SYNC_HOURS (banks allow about 4 unattended
    fetches a day), then cool-down alerts, and the weekly read on Monday mornings."""
    from . import ai, ai_usage, alerts, push
    if config.DEMO:
        return  # made-up banks: nothing to sync, no alerts to send

    def for_user():
        with db.connect() as conn:
            last = db.get_meta(conn, "last_attempt")
        due = not last or datetime.fromisoformat(last) < datetime.now(timezone.utc) - timedelta(hours=config.SYNC_HOURS)
        if due:
            sync()
        # Also flushes alerts held back during quiet hours.
        alerts.check()
        if _weekly_read_due():
            try:
                read = ai.weekly_read()
            except (ai_usage.BudgetExceeded, ai_usage.NoAPIKey) as e:
                log.info("no weekly read for user %s: %s", db.current_user(), e)
                read = None
            if read:
                push.send("Your week", read["headline"], url="/", tag="weekly-read")

    def one_round():
        try:
            users = db.active_users()
        except Exception:
            log.exception("couldn't list users")
            users = []
        for user_id in users:
            try:
                with db.as_user(user_id):
                    for_user()
            except Exception:  # e.g. the key file is missing; log it and keep the loop alive
                log.exception("scheduled work failed for user %s", user_id)

    def loop():
        while True:
            # Every pod runs this loop; one round at a time across them, so each sees what the last wrote
            # (last_attempt, alerts sent) and nothing is fetched or sent twice.
            try:
                with db.advisory_lock(db.LOCK_SCHEDULER, 0) as mine:
                    if mine:
                        one_round()
            except Exception:
                log.exception("scheduler round failed")
            time.sleep(300)
    threading.Thread(target=loop, daemon=True, name="scheduler").start()

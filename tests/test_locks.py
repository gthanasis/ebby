"""Two pods share one database, so "one at a time" is a Postgres lock, not one in a pod's memory.

Each advisory_lock holds its own pooled connection, so two of them in this process contend exactly
as two pods would.
"""

from app.data import db
from app.jobs import sync


def test_only_one_scheduler_round_at_a_time():
    with db.advisory_lock(db.LOCK_SCHEDULER, 0) as first:
        with db.advisory_lock(db.LOCK_SCHEDULER, 0) as second:
            assert first and not second
    with db.advisory_lock(db.LOCK_SCHEDULER, 0) as after:
        assert after  # released when the round ends


def test_a_sync_running_on_another_pod_is_seen_and_not_doubled(users, monkeypatch):
    ran = []
    monkeypatch.setattr(sync, "_sync_all", lambda psu: ran.append(psu) or True)
    with db.as_user(users["b"]):
        assert not sync.is_syncing()
        with db.advisory_lock(db.LOCK_SYNC, users["b"]):  # the other pod, mid-sync
            assert sync.is_syncing()
            assert sync.sync() is False and ran == []
        assert not sync.is_syncing()
        assert sync.sync() is True and ran == [None]


def test_one_persons_sync_doesnt_hold_up_anothers(users, monkeypatch):
    monkeypatch.setattr(sync, "_sync_all", lambda psu: True)
    with db.as_user(users["a"]), db.advisory_lock(db.LOCK_SYNC, users["a"]):
        with db.as_user(users["b"]):
            assert not sync.is_syncing() and sync.sync() is True


def test_a_payday_changed_on_another_pod_is_picked_up(users, monkeypatch):
    from app.domain import insights
    with db.as_user(users["a"]):
        with db.connect() as conn:
            before = db.get_meta(conn, "settings") or {}
        try:
            insights.set_payday(25)  # this pod's cache
            with db.connect() as conn:  # the other pod saves a new payday
                db.set_meta(conn, "settings", {**before, "payday": "last"})
            assert insights.payday() == 25  # still within the minute
            monkeypatch.setattr(insights, "PAYDAY_TTL", 0)
            assert insights.payday() == "last"
        finally:
            with db.connect() as conn:
                db.set_meta(conn, "settings", before)
            insights._paydays.clear()

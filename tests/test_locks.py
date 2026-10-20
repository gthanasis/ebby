"""Two pods share one database, so "one at a time" is a Postgres lock, not one in a pod's memory.

Each advisory_lock holds its own pooled connection, so two of them in this process contend exactly
as two pods would.
"""

from app import db, sync


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

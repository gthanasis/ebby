"""One database for everyone: nobody may ever see or change another person's rows."""

import threading

import psycopg
import pytest
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import config, server
from app.data import db
from app.jobs import sync

# Path parameters for routes that need them, so every GET route gets called.
PATH_VALUES = {"category": "delivery", "tx_id": "acc-AAA:0", "cid": "1", "hid": "1", "goal_id": "1", "wid": "1", "yid": "1",
               "action_id": "1", "path": "api"}


@pytest.fixture
def client_as(monkeypatch, users):
    """A client whose requests act as the given user (local runs act as the admin, so point that at them)."""
    monkeypatch.setattr(sync, "run_scheduler", lambda: None)

    def make(who):
        monkeypatch.setattr(server.db, "admin_id", lambda: users[who])
        return TestClient(server.app)
    return make


def _all_routes(routes):
    """Every route, including those of included routers (which FastAPI keeps nested)."""
    for route in routes:
        if hasattr(route, "original_router"):
            yield from _all_routes(route.original_router.routes)
        else:
            yield route


def _get_routes():
    for route in _all_routes(server.app.routes):
        path = getattr(route, "path", "")
        if "GET" in getattr(route, "methods", set()) and path.startswith("/api"):
            for name, value in PATH_VALUES.items():
                path = path.replace(f"{{{name}}}", value).replace(f"{{{name}:path}}", value)
            yield path


def test_no_get_route_shows_another_users_data(client_as):
    client = client_as("b")
    checked = 0
    for path in _get_routes():
        body = client.get(path).text
        assert "AAA" not in body, f"{path} shows user A's data to user B"
        checked += 1
    assert checked > 20  # the route list really was walked


def test_own_data_still_shows(client_as):
    body = client_as("b").get("/api/transactions").text
    assert "Shop BBB" in body and "Shop AAA" not in body


def test_cannot_recategorize_another_users_payment(client_as, users):
    client_as("b").put("/api/transactions/acc-AAA:0/category", json={"category": "eating_out"})
    with db.as_user(users["a"]), db.connect() as conn:
        assert conn.execute("SELECT category FROM transactions WHERE id = 'acc-AAA:0'").fetchone()["category"] == "groceries"
    with db.as_user(users["b"]), db.connect() as conn:
        assert not conn.execute("SELECT 1 FROM rules WHERE merchant = 'Shop AAA'").fetchone()


def test_without_a_user_connect_refuses():
    with pytest.raises(db.NoUser):
        with db.connect():
            pass


def test_app_role_without_a_user_sees_nothing_and_writes_nothing(users):
    with psycopg.connect(config.DATABASE_URL, autocommit=True) as pg:
        for table in ("transactions", "accounts", "rules", "meta", "goals", "commitments", "connections"):
            assert pg.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0, table
        with pytest.raises(psycopg.Error):
            pg.execute("INSERT INTO rules(merchant, category) VALUES('x', 'y')")


def test_app_role_cannot_write_into_another_users_rows(users):
    with db.as_user(users["b"]), db.connect() as conn:
        assert conn.execute("UPDATE transactions SET amount = 0 WHERE id = 'acc-AAA:0'").rowcount == 0
        with pytest.raises(psycopg.Error):
            conn.execute("INSERT INTO rules(user_id, merchant, category) VALUES(?, 'sneaky', 'x')", (users["a"],))


def test_a_pooled_connection_forgets_the_user(users):
    with db.as_user(users["a"]), db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 3
    for _ in range(3):  # whichever pooled connection comes back
        with db.connect_system() as conn:
            assert conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0] == 0


def test_threads_keep_the_user_only_through_db_thread(users):
    seen = {}
    with db.as_user(users["b"]):
        db.thread(lambda: seen.update(kept=db.current_user())).join()
        plain = threading.Thread(target=lambda: seen.update(plain=db.current_user()))
        plain.start()
        plain.join()
    assert seen == {"kept": users["b"], "plain": None}


def test_streamed_responses_act_as_the_requests_user(client_as, users):
    @server.app.get("/api/_test_stream")
    def stream():
        def events():
            with db.connect() as conn:
                yield conn.execute("SELECT merchant FROM transactions ORDER BY merchant LIMIT 1").fetchone()["merchant"]
        return StreamingResponse(events())
    # Ahead of the web app's catch-all route, which would otherwise answer first.
    server.app.router.routes.insert(0, server.app.router.routes.pop())
    try:
        assert client_as("b").get("/api/_test_stream").text == "Salary BBB"
    finally:
        server.app.router.routes = [r for r in server.app.router.routes if getattr(r, "path", "") != "/api/_test_stream"]


def test_scheduler_runs_each_user_as_themselves(monkeypatch, users):
    from app.domain import ai, alerts
    ran = []
    monkeypatch.setattr(sync, "sync", lambda: ran.append(("sync", db.current_user())))
    monkeypatch.setattr(alerts, "check", lambda: ran.append(("alerts", db.current_user())))
    monkeypatch.setattr(sync, "_weekly_read_due", lambda: False)
    monkeypatch.setattr(sync.time, "sleep", lambda s: (_ for _ in ()).throw(SystemExit))
    started = []
    monkeypatch.setattr(sync.threading, "Thread", lambda target, **kw: started.append(target) or type("T", (), {"start": lambda self: None})())
    sync.run_scheduler()
    with pytest.raises(SystemExit):
        started[0]()
    assert ("alerts", users["a"]) in ran and ("alerts", users["b"]) in ran


def test_each_person_keeps_their_own_payday(users):
    from app.domain import insights
    with db.as_user(users["a"]):
        insights.set_payday(25)
    with db.as_user(users["b"]):
        insights.set_payday("last")
    with db.as_user(users["a"]):
        assert insights.payday() == 25
    with db.as_user(users["b"]):
        assert insights.payday() == "last"


def test_transfers_to_yourself_use_your_own_names():
    from app.domain.categories import categorize
    assert categorize("To Maria Papadopoulou", None, True, False, ["Maria Papadopoulou"]) == "transfer"
    assert categorize("To Maria Papadopoulou", None, True, False, ["Nikos K"]) == "people"

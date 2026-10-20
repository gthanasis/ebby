"""The API as a black box: a fresh database holding only the demo person, the clock pinned, requests over HTTP.

By default the requests go to this app in-process. With API_BASE_URL set they go to a server already running
there instead (another implementation of the same API, say), which must use this suite's database
(bank_sync_api on TEST_DATABASE_OWNER_URL's server), run in local mode (no sign-in configured, a localhost
PUBLIC_URL: requests act as the admin, here the demo person), and get the same EBBY_NOW.

Snapshots of what each read returns are in snapshots/. UPDATE_SNAPSHOTS=1 rewrites them; review the diff.
"""

import os

import httpx
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from tests.conftest import OWNER

API_DB = "bank_sync_api"
NOW = "2026-10-20T09:00:00+03:00"  # a Tuesday morning in Athens, mid pay month


@pytest.fixture(scope="module")
def demo(monkeypatch_module):
    """Points the app at a fresh database, seeds the demo person into it, and pins the clock."""
    from app import config
    from app.data import credentials, db, demo
    from app.domain import insights
    from app.integrations import banks

    with psycopg.connect(OWNER, autocommit=True) as pg:
        pg.execute(f"DROP DATABASE IF EXISTS {API_DB} WITH (FORCE)")
        pg.execute(f"CREATE DATABASE {API_DB}")
    monkeypatch_module.setenv("EBBY_NOW", NOW)
    monkeypatch_module.setattr(config, "DATABASE_OWNER_URL", make_conninfo(OWNER, dbname=API_DB))
    monkeypatch_module.setattr(config, "DATABASE_URL", make_conninfo(OWNER, dbname=API_DB, user="bank_sync_test_app",
                                                                      password="test"))
    old_pool, db._pool = db._pool, None
    for cache in (insights._paydays, credentials._clients, banks._cache):
        cache.clear()
    db.init()
    seeded = demo.seed()
    yield seeded
    db._pool.close()
    db._pool = old_pool
    for cache in (insights._paydays, credentials._clients, banks._cache):
        cache.clear()


@pytest.fixture(scope="module")
def monkeypatch_module():
    with pytest.MonkeyPatch.context() as mp:
        yield mp


@pytest.fixture(scope="module")
def api(demo, monkeypatch_module):
    """An HTTP client acting as the demo person."""
    if base := os.environ.get("API_BASE_URL"):
        with httpx.Client(base_url=base, timeout=30) as client:
            yield client
        return
    from app import server
    from app.jobs import sync
    monkeypatch_module.setattr(sync, "run_scheduler", lambda: None)  # no background syncs mid-test
    with TestClient(server.app) as client:
        yield client

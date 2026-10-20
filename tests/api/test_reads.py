"""Every read endpoint, on the demo person's six months, returns exactly what it returned when the snapshot was taken.

These are the contract another implementation must meet: same status, same JSON, number for number.
"""

import json
import os
import re
from pathlib import Path

import pytest

SNAPSHOTS = Path(__file__).parent / "snapshots"

# Each read worth pinning, with the parameters that change what it computes. {service}, {habit} and {account} are
# filled from the demo data, so the snapshots don't depend on ids.
READS = [
    "/api/me", "/api/status", "/api/people", "/api/categories",
    "/api/home",
    "/api/spending", "/api/spending?range=day", "/api/spending?range=week", "/api/spending?range=year",
    "/api/spending?range=month&off=-1",
    "/api/spending/category?category=groceries", "/api/spending/category?category=eating_out&range=week",
    "/api/pace", "/api/pace?month=2026-09",
    "/api/category/groceries", "/api/category/delivery?month=2026-09",
    "/api/service?category=groceries&name={service}",
    "/api/subscriptions", "/api/year", "/api/year?year=2025",
    "/api/overview", "/api/overview?month=2026-09",
    "/api/transactions", "/api/transactions?category=groceries", "/api/transactions?account={account}&limit=20",
    "/api/transactions?q=wolt", "/api/transactions?limit=5&offset=5",
    "/api/plan", "/api/goals", "/api/goals/overview",
    "/api/commitments", "/api/commitments/services", "/api/commitments/services?transfers=true",
    "/api/habits", "/api/habits/weekly", "/api/habits/rules/{habit}",
    "/api/assistant", "/api/sorter",
]


def _fill(path: str, api) -> str:
    if "{service}" in path:
        top = api.get("/api/category/groceries").json()
        path = path.replace("{service}", _first_service(top))
    if "{account}" in path:
        path = path.replace("{account}", api.get("/api/status").json()["accounts"][0]["id"])
    if "{habit}" in path:
        path = path.replace("{habit}", str(api.get("/api/habits/weekly").json()["habits"][0]["id"]))
    return path


def _first_service(category_view: dict) -> str:
    for key in ("services", "merchants", "groups"):
        for item in category_view.get(key) or []:
            if isinstance(item, dict) and (name := item.get("name") or item.get("service")):
                return name
    raise AssertionError(f"no service in {list(category_view)}")


def _name(path: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", path.removeprefix("/api/").lower()).strip("_") + ".json"


def _diff(expected, actual, at="$") -> str | None:
    """Where two JSON values first differ, or None. Numbers equal to 1e-9 count as equal."""
    if isinstance(expected, dict) and isinstance(actual, dict):
        for key in sorted(set(expected) | set(actual)):
            if key not in actual:
                return f"{at}.{key}: missing"
            if key not in expected:
                return f"{at}.{key}: unexpected (= {json.dumps(actual[key])[:80]})"
            if d := _diff(expected[key], actual[key], f"{at}.{key}"):
                return d
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(expected) != len(actual):
            return f"{at}: {len(actual)} items, expected {len(expected)}"
        for i, (e, a) in enumerate(zip(expected, actual)):
            if d := _diff(e, a, f"{at}[{i}]"):
                return d
        return None
    numbers = (int, float)
    if isinstance(expected, numbers) and isinstance(actual, numbers) and not isinstance(expected, bool) \
            and not isinstance(actual, bool):
        return None if abs(expected - actual) <= 1e-9 * max(1, abs(expected)) else f"{at}: {actual}, expected {expected}"
    return None if expected == actual else f"{at}: {json.dumps(actual)[:120]}, expected {json.dumps(expected)[:120]}"


@pytest.mark.parametrize("path", READS)
def test_read_matches_snapshot(api, path):
    url = _fill(path, api)
    res = api.get(url)
    got = {"status": res.status_code, "body": res.json()}
    file = SNAPSHOTS / _name(path)
    if os.environ.get("UPDATE_SNAPSHOTS") or not file.exists():
        SNAPSHOTS.mkdir(exist_ok=True)
        file.write_text(json.dumps(got, ensure_ascii=False, indent=1, sort_keys=True) + "\n")
        if not os.environ.get("UPDATE_SNAPSHOTS"):
            pytest.fail(f"new snapshot {file.name}: review it, then run again")
        return
    want = json.loads(file.read_text())
    assert res.status_code == want["status"], f"{url}: status {res.status_code}, expected {want['status']}: {res.text[:200]}"
    assert (d := _diff(want["body"], got["body"])) is None, f"{url}: {d}"


def test_every_read_route_is_covered(api):
    """A new GET endpoint gets a snapshot here, or a reason it can't have one."""
    from app import server
    from tests.test_isolation import _all_routes
    skipped = {"/api/banks": "asks Enable Banking", "/api/push/key": "a key made per install", "/api/healthz": "no data"}
    covered = {p.split("?")[0] for p in READS}
    for route in _all_routes(server.app.routes):
        path = getattr(route, "path", "")
        if "GET" not in getattr(route, "methods", set()) or not path.startswith("/api/") or path in skipped:
            continue
        pattern = re.sub(r"\{[^}]+\}", "[^/]+", path) + "$"
        assert any(re.match(pattern, c) for c in covered), f"{path} has no snapshot in READS"

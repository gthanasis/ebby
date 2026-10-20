"""What the app changes through the API, checked the way the app would see it: through the reads.

Runs on its own fresh demo database (the fixtures are per module), so the read snapshots stay untouched.
"""


def _first(api, path: str, key: str = "rows") -> dict:
    return api.get(path).json()[key][0]


def _spent(api, category: str) -> float:
    return next((c["amount"] for c in api.get("/api/overview").json()["by_category"] if c["category"] == category), 0.0)


def _categories_of(api, merchant: str) -> set[str]:
    """Every category the payee's payments are in (q matches inside names, so compare whole ones)."""
    rows = api.get(f"/api/transactions?q={merchant}&limit=500").json()["rows"]
    return {t["category"] for t in rows if t["merchant"] == merchant}


def test_moving_a_payment_and_its_payee(api):
    tx = _first(api, "/api/transactions?q=wolt")
    before = _spent(api, "delivery")

    res = api.put(f"/api/transactions/{tx['id']}/category", json={"category": "eating_out"})
    assert res.status_code == 200 and res.json()["rule"] == f"tx:{tx['id']}" and res.json()["others"] > 0
    assert _spent(api, "delivery") < before  # only that one payment moved

    res = api.put(f"/api/transactions/{tx['id']}/category", json={"category": "eating_out", "all_from_merchant": True})
    assert res.json()["rule"] == tx["merchant"] and res.json()["others"] == 0
    assert _categories_of(api, tx["merchant"]) == {"eating_out"}


def test_moving_to_an_unknown_category_or_payment_is_refused(api):
    tx = _first(api, "/api/transactions")
    assert api.put(f"/api/transactions/{tx['id']}/category", json={"category": "yachts"}).status_code == 400
    assert api.put("/api/transactions/no-such-id/category", json={"category": "groceries"}).status_code == 404


def _services(api, category: str) -> set[str]:
    return {s["name"] for s in api.get(f"/api/category/{category}").json()["services"]}


def test_a_payee_answered_in_the_sorter_can_be_taken_back(api):
    service = sorted(_services(api, "groceries"))[0]
    assert api.post("/api/assistant/answer", json={"service": service, "category": "shopping"}).status_code == 200
    assert service not in _services(api, "groceries") and service in _services(api, "shopping")
    assert api.post("/api/sorter/undo", json={"service": service}).json()["moved"] > 0
    assert service in _services(api, "groceries")


def test_goals_are_added_changed_and_removed(api):
    count = len(api.get("/api/goals").json())
    assert api.post("/api/goals", json={"name": "Bike", "price": 600, "target_date": "2026-09-01"}).status_code == 400  # past

    goals = api.post("/api/goals", json={"name": "Bike", "price": 600, "target_date": "2027-04-01", "saved": 50}).json()
    assert len(goals) == count + 1  # answers with every goal
    goal = next(g for g in goals if g["name"] == "Bike")

    changed = api.patch(f"/api/goals/{goal['id']}", json={"add": 100})
    assert changed.status_code == 200
    bike = next(g for g in api.get("/api/goals").json() if g["id"] == goal["id"])
    assert bike["saved"] == 150

    assert api.delete(f"/api/goals/{goal['id']}").status_code in (200, 204)
    assert len(api.get("/api/goals").json()) == count


def test_a_commitment_takes_its_payments_out_of_free_spending(api):
    tx = _first(api, "/api/transactions?category=bills")
    before = _spent(api, "bills")
    res = api.post("/api/commitments", json={"name": "Phone and power", "kind": "fixed", "monthly_limit": 150,
                                              "services": [tx["merchant"]]})
    assert res.status_code == 200, res.text
    assert _spent(api, "bills") < before
    cid = next(c["id"] for c in api.get("/api/commitments").json()["items"] if c["name"] == "Phone and power")

    assert api.post("/api/commitments", json={"name": "Insurance", "monthly_limit": 0, "every_months": 6,
                                              "amount": 300}).status_code == 400  # every few months needs a next date
    assert api.delete(f"/api/commitments/{cid}").status_code in (200, 204)
    assert _spent(api, "bills") == before


def test_the_plan_and_a_months_working_limit(api):
    plan = api.get("/api/plan").json()
    res = api.put("/api/plan", json={"take_home": 2600, "keep": 300})
    assert res.status_code == 200, res.text
    assert api.get("/api/plan").json()["plan"]["take_home"] == 2600

    assert api.put("/api/plan/limit", json={"month": "2026-10", "limit": 1800}).status_code == 200
    assert api.put("/api/plan/limit", json={"month": "October", "limit": 1800}).status_code == 422
    assert api.get("/api/pace").json()["planned"] == 1800
    api.put("/api/plan", json={"take_home": plan["plan"]["take_home"], "keep": plan["plan"]["keep"]})


def test_payday_decides_where_the_pay_month_starts(api):
    assert api.get("/api/pace").json()["start"] == "2026-09-25"  # the demo is paid on the 25th
    assert api.put("/api/settings", json={"payday": 1}).status_code == 200
    pace = api.get("/api/pace").json()
    assert (pace["start"], pace["end"]) == ("2026-10-01", "2026-11-01")  # the end is the next month's first day
    api.put("/api/settings", json={"payday": 25})
    assert api.get("/api/pace").json()["start"] == "2026-09-25"


def test_habits_wishlist_and_yearly_costs(api):
    rule = api.post("/api/habits/rules", json={"type": "fewer", "category": "eating_out", "target": 2})
    assert rule.status_code == 200, rule.text
    hid = rule.json()["id"]
    assert api.patch(f"/api/habits/rules/{hid}", json={"target": 3}).status_code == 200
    assert api.get(f"/api/habits/rules/{hid}").json()["target"] == 3
    assert api.delete(f"/api/habits/rules/{hid}").status_code in (200, 204)

    assert api.post("/api/wishlist", json={"name": "", "price": 10}).status_code == 400
    wish = api.post("/api/wishlist", json={"name": "Headphones", "price": 180}).json()
    assert any(w["name"] == "Headphones" for w in api.get("/api/habits").json()["wishlist"])
    wid = wish["id"] if "id" in wish else next(w["id"] for w in api.get("/api/habits").json()["wishlist"]
                                               if w["name"] == "Headphones")
    assert api.post(f"/api/wishlist/{wid}/decide", json={"decision": "maybe"}).status_code == 400
    assert api.post(f"/api/wishlist/{wid}/decide", json={"decision": "skipped"}).status_code == 200

    assert api.post("/api/yearly", json={"name": "Car tax", "yearly_amount": 180, "due_month": 13}).status_code == 400
    assert api.post("/api/yearly", json={"name": "Car tax", "yearly_amount": 180, "due_month": 12}).status_code == 200
    assert any(y["name"] == "Car tax" for y in api.get("/api/habits").json()["yearly"]["items"])


def test_moving_a_whole_service(api):
    name = sorted(_services(api, "groceries"))[-1]
    res = api.post("/api/service/move", json={"category": "groceries", "name": name, "to": "shopping"})
    assert res.status_code == 200, res.text
    assert name not in _services(api, "groceries") and name in _services(api, "shopping")

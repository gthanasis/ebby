"""The Assistant tab: ask about your money, log cash, and change the app by talking.

Claude reads through tools that query the same data the screens show. It never changes anything
itself: every change is a proposal stored in assistant_actions, and only the user's "Do it" runs it.
The conversation is kept server-side and replayed unchanged, so thinking blocks stay valid.
"""

import hashlib
import json
import logging
from datetime import date, datetime, timezone

from collections.abc import Iterator

import anthropic

from . import ai, ai_usage, config, db, insights, spending
from .categories import CATEGORIES, SPENDING

log = logging.getLogger("bank-sync")
MAX_TOOL_ROUNDS = 6
CATEGORY_IDS = list(CATEGORIES)
SPEND_IDS = sorted(SPENDING)

SYSTEM = """You are the assistant in a personal spending app, read on a phone. You help one person
understand their money and keep the app organised. Amounts are euros.

- Each message from the person starts with a [Context] line: today's date and where this pay month
  stands. A "month" is a pay month (payday to the day before the next one); dates are Europe/Athens.
- Get every other number from the tools; never estimate or invent figures. Prefer one well-filtered
  call: find_payments for specific payments, totals for "how much" questions, get_overview for how
  the month is going against the plan.
- To change anything call the matching propose_ tool. That only drafts it; the person confirms with
  a button. Say in one sentence what will happen when they confirm; never say it is done.
- One payment ("that €44 Wolt order"): find it with find_payments, then propose_set_payment_category
  with its id. propose_set_category is only for every payment to a payee. If several fit, ask which.
- "20 bakery cash" means €20 cash spent at a bakery today: pick the category and propose_log_cash.
- Wanting to buy something non-essential: offer the 48-hour list (propose_wish) before a goal.
- Committed costs are the person's own choices; never suggest cutting them.
- Reply in two or three short sentences of plain text: no markdown, no lists unless asked. Be direct
  and specific, never shaming.

Category ids: {categories}."""


def _tool(name: str, description: str, props: dict, required: list[str] | None = None) -> dict:
    return {"name": name, "description": description, "strict": True,
            "input_schema": {"type": "object", "properties": props, "required": required if required is not None else list(props),
                             "additionalProperties": False}}


def _opt(kind: str, description: str | None = None) -> dict:
    return {"type": [kind, "null"], **({"description": description} if description else {})}


MONTH = _opt("string", "Pay month YYYY-MM, or null for the current one")
RANGE = {"month": _opt("string", "Pay month YYYY-MM, or null to use from/to (all time when all three are null)"),
         "from": _opt("string", "First day YYYY-MM-DD"), "to": _opt("string", "Last day YYYY-MM-DD")}
CATEGORY = _opt("string", "A category id")
SUMMARY = {"type": "string", "description": "One sentence shown on the confirm button"}
TOOLS = [
    _tool("find_payments", "Payments matching every filter given, newest first: up to 20 rows "
          "(id | date | amount | payee | category; spending is negative) plus how many matched and their sum.",
          {"text": _opt("string", "Part of the payee or description, e.g. 'wolt'"),
           "amount": _opt("number", "About this many euros (within 10%), e.g. 44"),
           "category": CATEGORY, **RANGE}),
    _tool("totals", "Spending summed by category, payee or month over a period, biggest first (up to 15 groups). "
          "Counts spending categories only, not income or transfers.",
          {"by": {"type": "string", "enum": ["category", "payee", "month"]},
           "text": _opt("string", "Only payees or descriptions containing this"), "category": CATEGORY, **RANGE}),
    _tool("get_overview", "A pay month against the plan: free spending, projection, each category against its budget, "
          "committed costs, cash.", {"month": MONTH}),
    _tool("get_plan", "The plan: take-home, keep, committed limits, free to spend, budgets per category.", {}),
    _tool("list_goals", "Savings goals with progress and what they need per week.", {}),
    _tool("propose_set_payment_category", "Draft: move one payment to a category; the payee's other payments stay.",
          {"transaction_id": {"type": "string", "description": "The id from find_payments"},
           "category": {"type": "string", "enum": CATEGORY_IDS}, "summary": SUMMARY}),
    _tool("propose_set_category", "Draft: move every payment to a payee to a category, now and later.",
          {"service": {"type": "string", "description": "Payee as find_payments shows it"},
           "category": {"type": "string", "enum": CATEGORY_IDS}, "summary": SUMMARY}),
    _tool("propose_commitment", "Draft: a commitment (fixed bill or chosen cost) with a monthly limit.",
          {"name": {"type": "string"}, "kind": {"type": "string", "enum": ["fixed", "chosen"]},
           "monthly_limit": {"type": "number"}, "services": {"type": "array", "items": {"type": "string"}},
           "off_bank": {"type": "number", "description": "Monthly amount paid outside the bank, e.g. rent in cash; 0 if none"},
           "note": {"type": "string"}, "summary": SUMMARY}),
    _tool("propose_budget", "Draft: the monthly budget of one free-spending category.",
          {"category": {"type": "string", "enum": SPEND_IDS}, "amount": {"type": "number"}, "summary": SUMMARY}),
    _tool("propose_plan", "Draft: change take-home pay and/or the amount kept each month.",
          {"take_home": {"type": "number"}, "keep": {"type": "number"}, "summary": SUMMARY}),
    _tool("propose_goal", "Draft: a new savings goal.",
          {"name": {"type": "string"}, "price": {"type": "number"}, "target_date": {"type": "string", "description": "YYYY-MM-DD"},
           "summary": SUMMARY}),
    _tool("propose_goal_saved", "Draft: money put aside for (or taken from) a goal.",
          {"goal_id": {"type": "integer"}, "add": {"type": "number", "description": "Negative to take out"}, "summary": SUMMARY}),
    _tool("propose_wish", "Draft: put something on the 48-hour 'thinking about it' list.",
          {"name": {"type": "string"}, "price": {"type": "number"}, "summary": SUMMARY}),
    _tool("propose_log_cash", "Draft: log cash spending; it comes out of what was withdrawn.",
          {"amount": {"type": "number"}, "category": {"type": "string", "enum": SPEND_IDS},
           "note": {"type": "string", "description": "Where or what, e.g. 'bakery'"},
           "date": {"type": "string", "description": "YYYY-MM-DD"}, "summary": SUMMARY}),
]


# ---------- read tools ----------

def _month(m):
    return m or insights.this_month()


def _overview(conn, month):
    p = insights.pace(conn, month)
    com = insights.commitments_view(conn, month)
    return {
        "month": month, "free_spent": p["total"], "free_plan": p["planned"], "projected": p["projected"],
        "day": p["elapsed"], "days": p["days"],
        "categories": [{k: c[k] for k in ("category", "spent", "budget", "status", "count", "habit")} for c in p["categories"] if c["spent"] or c["budget"]],
        "committed": [{"name": c["name"], "spent": c["spent"], "limit": c["monthly_limit"], "over": c["over"]} for c in com["items"]],
        "cash": insights.cash_view(conn, month),
    }


def _payments(conn, args) -> list[dict]:
    """Every payment the filters allow, newest first, named the way the app shows payees."""
    where, params = ["t.duplicate_of IS NULL", "t.status != 'OFFSET'"], []
    if args.get("month"):
        start, end = insights.month_bounds(args["month"])
        where.append("t.date >= ? AND t.date < ?"); params += [start, end]
    else:
        if args.get("from"):
            where.append("t.date >= ?"); params.append(args["from"])
        if args.get("to"):
            where.append("t.date <= ?"); params.append(args["to"])
    if args.get("category"):
        where.append("t.category = ?"); params.append(args["category"])
    if args.get("amount"):
        where.append("ABS(ABS(t.amount) - ?) <= ?"); params += [abs(args["amount"]), max(1.0, abs(args["amount"]) * 0.1)]
    rows = conn.execute(f"""SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card
        FROM transactions t JOIN accounts a ON a.id = t.account WHERE {' AND '.join(where)} ORDER BY t.date DESC, t.id""", params)
    text = (args.get("text") or "").strip().lower()
    out = []
    for r in rows:
        payee = insights.service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])
        if text and text not in f"{payee} {r['merchant'] or ''} {r['description'] or ''}".lower():
            continue
        out.append({"id": r["id"], "date": r["date"], "amount": r["amount"], "payee": payee, "category": r["category"]})
    return out


def _find(conn, args) -> dict:
    rows = _payments(conn, args)
    return {"matched": len(rows), "sum": round(sum(r["amount"] for r in rows), 2),
            "rows": [f"{_ref(r['id'])} | {r['date']} | {r['amount']:.2f} | {r['payee']} | {r['category']}" for r in rows[:20]]}


def _totals(conn, args) -> dict:
    groups: dict[str, list] = {}
    for r in _payments(conn, args):
        if r["category"] not in SPENDING or r["amount"] >= 0:
            continue
        key = r["category"] if args["by"] == "category" else r["payee"] if args["by"] == "payee" else insights.month_of(r["date"])
        g = groups.setdefault(key, [0.0, 0])
        g[0] -= r["amount"]; g[1] += 1
    ranked = sorted(groups.items(), key=lambda kv: kv[0] if args["by"] == "month" else -kv[1][0])
    return {"spent": round(sum(g[0] for g in groups.values()), 2), "groups": len(groups),
            "rows": [f"{k}: {v[0]:.2f} ({v[1]} payments)" for k, v in ranked[:15]]}


def _ref(tx_id: str) -> str:
    """A short stand-in for a transaction id (the bank's ids run to 150 characters), stable across calls."""
    return hashlib.sha1(tx_id.encode()).hexdigest()[:10]


def _tx_from_ref(conn, ref: str) -> str | None:
    ref = ref.strip().lower()
    return next((r[0] for r in conn.execute("SELECT id FROM transactions") if _ref(r[0]) == ref), None)


def _plan(conn):
    plan = insights.get_plan(conn)
    committed = insights.committed_total(conn)
    if not plan:
        return {"plan": None, "committed_limits": committed}
    return {**plan, "committed_limits": committed, "free_to_spend": round(plan["take_home"] - plan["keep"] - committed, 2)}


def _goals(conn):
    out = []
    for r in conn.execute("SELECT * FROM goals ORDER BY target_date"):
        g = insights.goal_view(conn, dict(r))
        out.append({k: g[k] for k in ("id", "name", "price", "saved", "target_date", "weekly", "monthly")})
    return out


def _run_read(conn, name, args):
    if name == "get_overview":
        return _overview(conn, _month(args.get("month")))
    if name == "find_payments":
        return _find(conn, args)
    if name == "totals":
        return _totals(conn, args)
    if name == "get_plan":
        return _plan(conn)
    if name == "list_goals":
        return _goals(conn)
    raise KeyError(name)


# ---------- actions (proposed by Claude, run only on the user's confirm) ----------

def _propose(conn, conversation, name, args) -> dict:
    kind = name.removeprefix("propose_")
    summary = args.pop("summary", "").strip() or kind.replace("_", " ")
    if kind == "set_payment_category":
        tx_id = _tx_from_ref(conn, args["transaction_id"])
        if not tx_id:
            return {"error": "No payment with that id; use an id from find_payments."}
        args["transaction_id"] = tx_id
    conn.execute("INSERT INTO assistant_actions(conversation, kind, params, summary, created_at) VALUES(?, ?, ?, ?, ?)",
                 (conversation, kind, json.dumps(args), summary, _now()))
    aid = conn.execute("SELECT lastval()").fetchone()[0]
    return {"status": "waiting for the user's confirmation", "action_id": aid}


def run_action(action_id: int) -> str:
    """Executes a confirmed proposal. Returns a short result line for the chat."""
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ?", (action_id,)).fetchone()
        if not row or row["status"] != "pending":
            raise ValueError("That change was already handled.")
        p = json.loads(row["params"])
        kind = row["kind"]
        if kind == "set_category":
            n = insights.set_service_category(conn, p["service"], p["category"])
            result = f"Moved {n} {p['service']} payments to {CATEGORIES[p['category']][0]}."
        elif kind == "set_payment_category":
            # The same rule the Spending list saves when one payment's category is changed.
            tx = conn.execute("SELECT date, amount FROM transactions WHERE id = ?", (p["transaction_id"],)).fetchone()
            if not tx:
                raise ValueError("That payment is no longer there.")
            conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
                         (f"tx:{p['transaction_id']}", p["category"]))
            db.recategorize(conn)
            result = f"Moved the €{abs(tx['amount']):,.2f} payment on {date.fromisoformat(tx['date'][:10]).strftime('%-d %b')} to {CATEGORIES[p['category']][0]}."
        elif kind == "commitment":
            conn.execute("""INSERT INTO commitments(name, kind, monthly_limit, note, services, off_bank, created_at)
                            VALUES(?, ?, ?, ?, ?, ?, ?)""",
                         (p["name"], p["kind"], p["monthly_limit"], p.get("note", ""), json.dumps(p.get("services", [])),
                          max(0, p.get("off_bank", 0)), _now()))
            insights.assign_commitments(conn)
            result = f"{p['name']} is committed, limit €{p['monthly_limit']:,.0f} a month."
        elif kind == "budget":
            plan = insights.get_plan(conn)
            if not plan:
                raise ValueError("Set up the plan first.")
            plan["budgets"][p["category"]] = float(p["amount"])
            db.set_meta(conn, "plan", plan)
            result = f"{CATEGORIES[p['category']][0]} budget is now €{p['amount']:,.0f} a month."
        elif kind == "plan":
            current = insights.get_plan(conn)
            insights.save_plan(conn, p["take_home"], p["keep"], current["budgets"] if current else None)
            result = f"Plan updated: take-home €{p['take_home']:,.0f}, keep €{p['keep']:,.0f}."
        elif kind == "goal":
            if date.fromisoformat(p["target_date"]) <= date.today():
                raise ValueError("The goal date has to be in the future.")
            conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at) VALUES(?, ?, 0, ?, ?)",
                         (p["name"], p["price"], p["target_date"], date.today().isoformat()))
            result = f"Added {p['name']}: €{p['price']:,.0f} by {p['target_date']}."
        elif kind == "goal_saved":
            conn.execute("UPDATE goals SET saved = MAX(0, saved + ?) WHERE id = ?", (p["add"], p["goal_id"]))
            result = "Goal updated."
        elif kind == "wish":
            from . import habits
            habits.add_wish(conn, p["name"], p["price"])
            result = f"{p['name']} is on the thinking-about-it list. I'll ask again in two days."
        elif kind == "log_cash":
            insights.log_cash(conn, p["amount"], p["category"], p.get("note", ""), p.get("date") or insights.local_today().isoformat())
            left = insights.cash_view(conn, insights.month_of(p["date"]) if p.get("date") else insights.this_month())["unaccounted"]
            result = f"Logged €{p['amount']:,.2f} cash as {CATEGORIES[p['category']][0]}. €{left:,.0f} of this month's cash is still unaccounted for."
        else:
            raise ValueError(f"Unknown change: {kind}")
        conn.execute("UPDATE assistant_actions SET status = 'done' WHERE id = ?", (action_id,))
        _store(conn, row["conversation"], "user", [{"type": "text", "text": f"[I confirmed: {row['summary']}. Result: {result}]"}])
        return result


def cancel_action(action_id: int):
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM assistant_actions WHERE id = ? AND status = 'pending'", (action_id,)).fetchone()
        if row:
            conn.execute("UPDATE assistant_actions SET status = 'cancelled' WHERE id = ?", (action_id,))
            _store(conn, row["conversation"], "user", [{"type": "text", "text": f"[I cancelled: {row['summary']}]"}])


# ---------- conversation ----------

def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _store(conn, conversation, role, content):
    conn.execute("INSERT INTO assistant_messages(conversation, role, content, created_at) VALUES(?, ?, ?, ?)",
                 (conversation, role, json.dumps(content, ensure_ascii=False), _now()))


def current_conversation(conn) -> int:
    return db.get_meta(conn, "assistant_conversation") or 1


def new_conversation():
    with db.connect() as conn:
        db.set_meta(conn, "assistant_conversation", current_conversation(conn) + 1)


def _history(conn, conversation) -> list[dict]:
    """API messages, merging consecutive same-role turns (confirm notes follow tool results)."""
    msgs = []
    for r in conn.execute("SELECT role, content FROM assistant_messages WHERE conversation = ? ORDER BY id", (conversation,)):
        content = json.loads(r["content"])
        if msgs and msgs[-1]["role"] == r["role"]:
            msgs[-1]["content"] = msgs[-1]["content"] + content
        else:
            msgs.append({"role": r["role"], "content": content})
    return msgs


def _detail(conn, kind, params) -> str | None:
    """The payment a single-payment change is about, so the card shows which one it is."""
    if kind != "set_payment_category":
        return None
    r = conn.execute("""SELECT t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                        JOIN accounts a ON a.id = t.account WHERE t.id = ?""", (json.loads(params)["transaction_id"],)).fetchone()
    if not r:
        return None
    name = insights.service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"])
    return f"{name} · €{abs(r['amount']):,.2f} · {date.fromisoformat(r['date'][:10]).strftime('%-d %b %Y')}"


def display(conversation: int | None = None) -> dict:
    """What the Assistant tab shows: your messages, Claude's text, and change cards."""
    with db.connect() as conn:
        conv = conversation or current_conversation(conn)
        actions = {r["id"]: {**dict(r), "detail": _detail(conn, r["kind"], r["params"])}
                   for r in conn.execute("SELECT id, kind, params, summary, status FROM assistant_actions WHERE conversation = ?", (conv,))}
        for a in actions.values():
            del a["params"]
        items = []
        for r in conn.execute("SELECT role, content FROM assistant_messages WHERE conversation = ? ORDER BY id", (conv,)):
            for block in json.loads(r["content"]):
                t = block.get("type")
                if r["role"] == "user" and t == "text" and block["text"].startswith(CONTEXT):
                    continue
                if r["role"] == "user" and t == "text" and not block["text"].startswith("[I "):
                    items.append({"type": "me", "text": block["text"]})
                elif r["role"] == "user" and t == "text":
                    items.append({"type": "note", "text": block["text"].strip("[]")})
                elif r["role"] == "user" and t == "tool_result":
                    try:
                        res = json.loads(block["content"]) if isinstance(block["content"], str) else {}
                    except ValueError:
                        res = {}
                    if isinstance(res, dict) and res.get("action_id") in actions:
                        items.append({"type": "action", **actions[res["action_id"]]})
                elif r["role"] == "assistant" and t == "text" and block.get("text", "").strip():
                    items.append({"type": "bot", "text": block["text"]})
        return {"conversation": conv, "items": items}


TOOL_STATUS = {
    "find_payments": "Searching your payments", "totals": "Adding it up", "get_overview": "Looking at the month",
    "get_plan": "Checking your plan", "list_goals": "Checking your goals",
}
CONTEXT = "[Context"


def _context(conn) -> str:
    """The little the assistant knows before any tool call, sent with each message. It goes into the
    message rather than the system prompt so the conversation stays append-only and the prompt caches."""
    today = insights.local_today()
    v = spending.view(conn, "month", 0)
    line = (f"{CONTEXT}: today {today.isoformat()} ({today.strftime('%A')}); pay month {v['key']} runs {v['start']} to {v['end']}, "
            f"day {v['elapsed']} of {v['length']}; free spending so far {v['total']:.0f}, usual by now {v['usual'] or 0:.0f}")
    plan = _plan(conn)
    if plan.get("free_to_spend") is not None:
        line += f"; free to spend a month {plan['free_to_spend']:.0f}"
    if extra := insights.extra_pay(conn):
        line += f"; next extra pay {extra[0]['name'].lower()} about {extra[0]['amount']:.0f} on {extra[0]['date']} (not in the monthly budget)"
    cash = insights.cash_view(conn, insights.this_month())["unaccounted"]
    return line + (f"; cash not yet accounted for {cash:.0f}]" if cash else "]")


def chat(text: str) -> dict:
    """The whole answer at once (kept for callers that don't stream)."""
    last = {}
    for event in chat_events(text):
        if event["type"] == "error":
            raise RuntimeError(event["text"])
        last = event
    return {k: v for k, v in last.items() if k != "type"}


def chat_events(text: str) -> Iterator[dict]:
    """The answer as it's written: text pieces, a status while it looks something up, then the
    finished conversation. Errors arrive as an event, so the stream always ends cleanly."""
    if not ai.available():
        yield {"type": "error", "text": "The assistant needs an Anthropic key. Add your own in Settings."}
        return
    with db.connect() as conn:
        conv = current_conversation(conn)
        # A reply leaves earlier unconfirmed drafts behind; they stay visible but can't run anymore.
        conn.execute("UPDATE assistant_actions SET status = 'expired' WHERE conversation = ? AND status = 'pending'", (conv,))
        _store(conn, conv, "user", [{"type": "text", "text": _context(conn)}, {"type": "text", "text": text}])
        model = ai.assistant_model(conn)
    # Tools and instructions never change, so they cache; the conversation after them only grows.
    system = [{"type": "text", "text": SYSTEM.format(categories=", ".join(CATEGORY_IDS)), "cache_control": {"type": "ephemeral"}}]

    for _ in range(MAX_TOOL_ROUNDS):
        with db.connect() as conn:
            messages = _history(conn, conv)
        try:
            claude = ai.client("assistant")
        except (ai_usage.BudgetExceeded, ai_usage.NoAPIKey) as e:
            yield {"type": "error", "text": str(e)}
            return
        try:
            with claude.client.beta.messages.stream(
                model=model, max_tokens=16000, system=system, tools=TOOLS, messages=messages,
                output_config={"effort": "low"}, cache_control={"type": "ephemeral"}, **ai.fallback(model),
            ) as stream:
                for event in stream:
                    if event.type == "text":
                        yield {"type": "text", "text": event.text}
                response = stream.get_final_message()
        except anthropic.RateLimitError:
            yield {"type": "error", "text": "The assistant is busy right now. Try again in a moment."}
            return
        except anthropic.APIStatusError as e:
            log.error("assistant failed (%s): %s", e.status_code, e.message)
            yield {"type": "error", "text": "The assistant couldn't answer right now. Try again in a moment."}
            return
        except anthropic.APIConnectionError:
            yield {"type": "error", "text": "Couldn't reach the assistant. Try again in a moment."}
            return
        ai.record(claude, model, response.usage)
        log.info("assistant (%s): %d in (%d cached, %d written) / %d out", model, response.usage.input_tokens,
                 response.usage.cache_read_input_tokens or 0, response.usage.cache_creation_input_tokens or 0, response.usage.output_tokens)
        content = [b.model_dump(exclude_none=True) for b in response.content]
        with db.connect() as conn:
            _store(conn, conv, "assistant", content)
        if response.stop_reason == "refusal":
            with db.connect() as conn:
                _store(conn, conv, "assistant", [{"type": "text", "text": "I can't help with that one."}])
            break
        uses = [b for b in response.content if b.type == "tool_use"]
        if response.stop_reason != "tool_use" or not uses:
            break
        results = []
        for u in uses:
            if u.name in TOOL_STATUS:
                yield {"type": "status", "text": TOOL_STATUS[u.name] + "…"}
        with db.connect() as conn:
            for u in uses:
                try:
                    out = _propose(conn, conv, u.name, dict(u.input)) if u.name.startswith("propose_") else _run_read(conn, u.name, dict(u.input))
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": json.dumps(out, ensure_ascii=False, default=str)})
                except Exception as e:  # report to Claude, which can explain or retry
                    log.warning("assistant tool %s failed: %s", u.name, e)
                    results.append({"type": "tool_result", "tool_use_id": u.id, "content": f"Error: {e}", "is_error": True})
            _store(conn, conv, "user", results)
    yield {"type": "done", **display(conv)}

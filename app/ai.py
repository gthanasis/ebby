"""The weekly read: Claude looks at the last 90 days and says what's driving the spending."""

import logging
from datetime import date, datetime, timedelta, timezone
from typing import NamedTuple

import anthropic
from pydantic import BaseModel, Field

from . import ai_usage, config, credentials, db, insights, users
from .categories import CATEGORIES

log = logging.getLogger("bank-sync")

SYSTEM = """You review one person's spending each week and tell them, plainly, what is driving it.

They asked for scrutiny: they know they overspend and want their habits named. Be direct and
specific, never shaming. Use their real numbers (euros, counts, merchants, weekdays). Compare
against their plan and their own recent months, not against generic advice. One idea per
sentence; no markdown, no lists in the body, no greetings, no exclamation marks.

It is read on a phone in a few seconds. Keep the headline, findings and actions short and
concrete: a person should get the whole picture from those alone. Put nuance in the body.

Committed costs (listed as such) are choices the person has made, like a meal plan or a tool they
invest in. Never suggest cutting them; mention one only if it went past its limit.

"Own transfers", "Card repayments" and "Income" are not spending; ignore them except to judge
income. Cash withdrawals hide where money went; say so when they are large. Card rows marked
"Card · ..." have no merchant name from the bank, only a merchant type."""


class Finding(BaseModel):
    title: str = Field(description="What happened, under 32 characters, e.g. 'Monday Wolt runs'")
    detail: str = Field(description="The specifics, under 40 characters, e.g. '10 orders on two Mondays'")
    amount: float = Field(description="Euros involved this month (or per week if unit is 'week')")
    unit: str = Field(description="'month' for a total, 'week' for a weekly amount")
    category: str = Field(description="One of the category ids: " + ", ".join(CATEGORIES))


class Action(BaseModel):
    text: str = Field(description="One concrete change, under 70 characters, e.g. 'Cook on Tuesdays and Thursdays'")
    saves_monthly: float = Field(description="Euros a month this would save, estimated from their own numbers")


class WeeklyRead(BaseModel):
    headline: str = Field(description="The single most important observation, under 70 characters. Used as a push notification.")
    findings: list[Finding] = Field(description="The 3 things that drove spending most, biggest first. Each must be specific.")
    actions: list[Action] = Field(description="Up to 3 changes that would matter most, biggest saving first")
    body: str = Field(description="The full note for anyone who wants detail: 2 to 4 short sentences comparing with plan and recent months.")


def available() -> bool:
    """Whether this person can use Claude at all: the owner's key is set, or they added their own."""
    if config.ANTHROPIC_API_KEY:
        return True
    with db.connect() as conn:
        return "anthropic" in credentials.public(conn)


class Claude(NamedTuple):
    client: anthropic.Anthropic
    own_key: bool
    feature: str  # assistant / weekly_read / explain / sorter, for the usage log


def client(feature: str) -> Claude:
    """A client for the current person: their own key with no limit, or the owner's key while this
    month's allowance lasts. Called before every request, so a tool loop stops once it runs out.
    Raises ai_usage.BudgetExceeded or ai_usage.NoAPIKey, whose messages are fit to show."""
    person = users.me(db.current_user())
    now = datetime.now(timezone.utc)
    with db.connect() as conn:
        spent = conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE at >= ? AND NOT own_key",
                             (ai_usage.month_bounds(now)[0],)).fetchone()[0]
    key, own = ai_usage.choose_key(own_key=credentials.anthropic_key(), shared_key=config.ANTHROPIC_API_KEY,
                                   is_admin=person["is_admin"], spent=spent, budget=person["ai_budget_usd"], today=now)
    # The workspace belongs to the owner's key; someone's own key bills wherever it's scoped.
    headers = {"anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID} if config.ANTHROPIC_WORKSPACE_ID and not own else None
    return Claude(anthropic.Anthropic(api_key=key, default_headers=headers), own, feature)


def record(claude: Claude, model: str, usage):
    """Logs what one response cost, which is what the allowance counts."""
    cost = ai_usage.cost_usd(model, usage)
    get = (lambda f: getattr(usage, f, None) or 0)
    with db.connect() as conn:
        conn.execute("""INSERT INTO ai_usage(feature, model, input, cache_read, cache_write, output, cost_usd, own_key)
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?)""",
                     (claude.feature, model, get("input_tokens"), get("cache_read_input_tokens"),
                      get("cache_creation_input_tokens"), get("output_tokens"), cost, claude.own_key))


def assistant_model(conn) -> str:
    """The model for the chat and the sorter: the one picked in Settings, else ASSISTANT_MODEL."""
    picked = (db.get_meta(conn, "settings") or {}).get("assistant_model")
    return config.ASSISTANT_MODELS.get(picked, config.ASSISTANT_MODEL)


def fallback(model: str) -> dict:
    """Request arguments that retry a declined request on another model. Haiku has no such fallback."""
    if model.startswith("claude-haiku"):
        return {}
    return {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}


def _context(conn) -> str:
    today = date.today()
    since = (today - timedelta(days=90)).isoformat()
    month = insights.this_month()
    p = insights.pace(conn, month)
    plan = insights.get_plan(conn)
    lines = [f"Today: {today.isoformat()} ({today.strftime('%A')}). Day {p['elapsed']} of {p['days']} of the pay month "
             f"({p['start']} to the day before {p['end']}); 'this month' below means this pay month."]
    if plan:
        lines.append(f"Plan: take-home €{plan['take_home']:,.0f}/month, keep €{plan['keep']:,.0f}, spend €{sum(plan['budgets'].values()):,.0f}.")
        limit = (plan.get("limits") or {}).get(month)
        if limit:
            lines.append(f"This pay month has a working limit of €{limit:,.0f} on the way down to that plan; budgets below are scaled to it.")
    lines.append(f"This month so far: €{p['total']:,.0f} spent, projected €{p['projected']:,.0f}.")
    lines.append("\nThis month by category (spent / budget / count):")
    for c in p["categories"]:
        if c["spent"] or c["budget"]:
            lines.append(f"- {CATEGORIES[c['category']][0]}: €{c['spent']:,.0f} / {('€%s' % format(c['budget'], ',.0f')) if c['budget'] else 'no budget'} / {c['count']}")
    lines.append("\nLast 6 complete months, average per month by category:")
    for cat, avg in sorted(insights.averages(conn).items(), key=lambda kv: -kv[1]):
        lines.append(f"- {CATEGORIES[cat][0]}: €{avg:,.0f}")
    com = insights.commitments_view(conn, month)
    if com["items"]:
        lines.append("\nCommitted costs (chosen, not to be cut; this month / limit): " + "; ".join(
            f"{c['name']} €{c['spent']:,.0f} / €{c['monthly_limit']:,.0f}{' (over)' if c['over'] else ''}{(' (' + c['note'] + ')') if c['note'] else ''}"
            for c in com["items"]))
        lines.append("Budgets and 'this month' above cover free spending only.")
    subs = insights.subscriptions(conn)
    if subs["items"]:
        lines.append(f"\nSubscriptions: {subs['count']} active, €{subs['monthly']:,.0f}/month: "
                     + ", ".join(f"{s['name']} €{s['monthly']:,.0f}{' (no charge recently)' if s['stale'] else ''}" for s in subs["items"]))
    goals = [dict(r) for r in conn.execute("SELECT * FROM goals ORDER BY target_date")]
    if goals:
        lines.append("\nSaving for: " + "; ".join(
            f"{g['name']} €{g['price']:,.0f} by {g['target_date']} (€{g['saved']:,.0f} saved)" for g in goals))
    lines.append("\nTransactions, last 90 days (date,amount,category,merchant,account):")
    for r in conn.execute("""
        SELECT t.date, t.amount, t.currency, t.category, t.merchant, t.description, t.mcc, t.commitment_id, a.name AS account, a.is_card
        FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.duplicate_of IS NULL ORDER BY t.date
    """, (since,)):
        name = insights.service_name(r["merchant"], r["description"], bool(r["is_card"]), r["mcc"]).replace(",", " ")
        cur = "" if r["currency"] == "EUR" else f" {r['currency']}"
        label = "Committed" if r["commitment_id"] else CATEGORIES.get(r["category"], (r["category"],))[0]
        lines.append(f"{r['date']},{r['amount']:.2f}{cur},{label},{name},{r['account']}")
    return "\n".join(lines)


def weekly_read() -> dict | None:
    """Generates and stores this week's read. Returns it, or None when it couldn't be made."""
    if not available():
        return None
    with db.connect() as conn:
        context = _context(conn)
        plan = insights.get_plan(conn)
    claude = client("weekly_read")  # BudgetExceeded / NoAPIKey: the caller decides how to say so
    try:
        # Server-side fallback: if a safety classifier declines, the API retries on another model.
        response = claude.client.beta.messages.parse(
            model=config.ANTHROPIC_MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config={"effort": "medium"},
            system=SYSTEM,
            messages=[{"role": "user", "content": context}],
            output_format=WeeklyRead,
        )
    except anthropic.RateLimitError as e:
        log.warning("weekly read rate limited: %s", e.message)
        return None
    except anthropic.APIStatusError as e:
        log.error("weekly read failed (%s): %s", e.status_code, e.message)
        return None
    except anthropic.APIConnectionError:
        log.error("weekly read: could not reach the Anthropic API")
        return None
    record(claude, config.ANTHROPIC_MODEL, response.usage)
    if response.stop_reason == "refusal" or response.parsed_output is None:
        log.warning("weekly read not produced (stop_reason=%s)", response.stop_reason)
        return None
    read = {**response.parsed_output.model_dump(), "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "model": response.model, "budgets": (plan or {}).get("budgets")}
    log.info("weekly read: %d input / %d output tokens", response.usage.input_tokens, response.usage.output_tokens)
    with db.connect() as conn:
        db.set_meta(conn, "weekly_read", read)
    return read


EXPLAIN_SYSTEM = """You explain one period of a person's spending (a day, week, pay month or year) in plain words.

Say what was different about it and why, using their real numbers: amounts, counts, services, days.
Compare with the period before and with their usual, as given. Be direct and specific, never shaming.
No markdown, no greetings, no exclamation marks. It is read on a phone in a few seconds.

Committed costs are not in these numbers. A category being low early in a period is often just a bill
that hasn't been charged yet; don't present that as a saving."""


class Explanation(BaseModel):
    headline: str = Field(description="The one thing that defined the period, under 60 characters")
    points: list[str] = Field(description="2 or 3 short sentences, each one specific finding with numbers")
    try_: str = Field(alias="try", description="One concrete thing to try next, with what it would save, under 120 characters")


def explain(context: str) -> dict | None:
    """Claude's read of one period. None when it couldn't be made."""
    if not available():
        return None
    claude = client("explain")
    try:
        response = claude.client.beta.messages.parse(
            model=config.ANTHROPIC_MODEL, max_tokens=4000, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            output_config={"effort": "low"}, system=EXPLAIN_SYSTEM,
            messages=[{"role": "user", "content": context}], output_format=Explanation,
        )
    except (anthropic.APIStatusError, anthropic.APIConnectionError) as e:
        log.warning("explain failed: %s", getattr(e, "message", e))
        return None
    record(claude, config.ANTHROPIC_MODEL, response.usage)
    if response.stop_reason == "refusal" or response.parsed_output is None:
        return None
    return {**response.parsed_output.model_dump(by_alias=True), "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}

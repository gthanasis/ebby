"""What each Claude call costs, and whose key pays for it: friends spend a monthly allowance on the
owner's key, or bring their own key with no limit."""

from datetime import date, datetime
from typing import NamedTuple
from zoneinfo import ZoneInfo

from . import config


class Price(NamedTuple):
    """USD per million tokens."""

    input: float
    cache_write: float  # 5-minute TTL, 1.25x input
    cache_read: float
    output: float


# Anthropic first-party API rates, from the claude-api skill's model table (cached 2026-10-06).
PRICES = {
    "claude-opus-5-5": Price(4.00, 5.00, 0.20, 20.00),
    "claude-sonnet-5-5": Price(2.00, 2.50, 0.20, 10.00),
    "claude-haiku-5-5": Price(0.10, 0.125, 0.01, 0.50),
}
# Haiku 5.5 costs more once the prompt passes 100K tokens.
LONG_PROMPT = {"claude-haiku-5-5": (100_000, Price(0.50, 0.625, 0.05, 2.50))}

# An unknown model is charged at the dearest known price so the allowance never under-counts.
_TOP_PRICE = max(PRICES.values(), key=lambda p: p.output)


def _tokens(usage, field: str) -> int:
    value = usage.get(field) if isinstance(usage, dict) else getattr(usage, field, None)
    return value or 0


def cost_usd(model: str, usage) -> float:
    """Dollar cost of one response, from its `usage` (an Anthropic object or a dict)."""
    fresh = _tokens(usage, "input_tokens")
    written = _tokens(usage, "cache_creation_input_tokens")
    read = _tokens(usage, "cache_read_input_tokens")
    output = _tokens(usage, "output_tokens")
    price = PRICES.get(model, _TOP_PRICE)
    if model in LONG_PROMPT:
        threshold, long_price = LONG_PROMPT[model]
        if fresh + written + read > threshold:
            price = long_price
    return (
        fresh * price.input + written * price.cache_write + read * price.cache_read + output * price.output
    ) / 1_000_000


def _local_date(today: date | datetime) -> date:
    if isinstance(today, datetime):
        if today.tzinfo is not None:
            today = today.astimezone(ZoneInfo(config.TIMEZONE))
        return today.date()
    return today


def _next_month(day: date) -> date:
    return date(day.year + 1, 1, 1) if day.month == 12 else date(day.year, day.month + 1, 1)


def month_bounds(today: date | datetime) -> tuple[datetime, datetime]:
    """Start (inclusive) and end (exclusive) of this month in the app's timezone, for summing usage."""
    tz = ZoneInfo(config.TIMEZONE)
    day = _local_date(today)
    start = datetime(day.year, day.month, 1, tzinfo=tz)
    end_day = _next_month(day)
    return start, datetime(end_day.year, end_day.month, 1, tzinfo=tz)


def resets_on(today: date | datetime) -> date:
    return _next_month(_local_date(today))


class BudgetExceeded(Exception):
    """This month's allowance on the shared key is used up."""

    def __init__(self, spent: float, budget: float, resets_on: date):
        self.spent = spent
        self.budget = budget
        self.resets_on = resets_on
        super().__init__(
            f"You've used this month's AI allowance. It resets on {resets_on.day} {resets_on:%B}, "
            "or add your own Anthropic key in Settings."
        )


class NoAPIKey(Exception):
    """Neither the user nor the server has an Anthropic key."""

    def __init__(self):
        super().__init__("AI features need an Anthropic key. Add your own in Settings.")


def choose_key(
    *, own_key: str | None, shared_key: str, is_admin: bool, spent: float, budget: float, today
) -> tuple[str, bool]:
    """The key to call Claude with, and whether it is the user's own (which has no limit)."""
    if own_key:
        return own_key, True
    if not shared_key:
        raise NoAPIKey()
    if not is_admin and spent >= budget:
        raise BudgetExceeded(spent, budget, resets_on(today))
    return shared_key, False

from datetime import date, datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from app import ai_usage, config
from app.ai_usage import BudgetExceeded, NoAPIKey, choose_key, cost_usd, month_bounds

MILLION = 1_000_000
FULL = {
    "input_tokens": 10_000,
    "cache_creation_input_tokens": 20_000,
    "cache_read_input_tokens": 30_000,
    "output_tokens": 4_000,
}


def test_every_configured_model_has_a_price():
    for model in [*config.ASSISTANT_MODELS.values(), config.ANTHROPIC_MODEL]:
        assert model in ai_usage.PRICES


@pytest.mark.parametrize(
    "model, per_million",
    [
        ("claude-opus-5-5", (4.00, 5.00, 0.20, 20.00)),
        ("claude-sonnet-5-5", (2.00, 2.50, 0.20, 10.00)),
        ("claude-haiku-5-5", (0.10, 0.125, 0.01, 0.50)),
    ],
)
def test_cost_counts_every_kind_of_token(model, per_million):
    usage = {
        "input_tokens": 10_000,
        "cache_creation_input_tokens": 20_000,
        "cache_read_input_tokens": 30_000,
        "output_tokens": 4_000,
    }
    fresh, write, read, out = per_million
    expected = (10_000 * fresh + 20_000 * write + 30_000 * read + 4_000 * out) / MILLION
    assert cost_usd(model, usage) == pytest.approx(expected)


def test_cost_reads_usage_objects_and_none_fields():
    usage = SimpleNamespace(
        input_tokens=2_000, output_tokens=500, cache_creation_input_tokens=None, cache_read_input_tokens=None
    )
    assert cost_usd("claude-sonnet-5-5", usage) == pytest.approx((2_000 * 2.00 + 500 * 10.00) / MILLION)
    assert cost_usd("claude-sonnet-5-5", {"input_tokens": None, "output_tokens": 1_000}) == pytest.approx(0.01)
    assert cost_usd("claude-sonnet-5-5", {}) == 0


def test_cache_reads_are_cheaper_than_fresh_input():
    fresh = cost_usd("claude-opus-5-5", {"input_tokens": 10_000})
    cached = cost_usd("claude-opus-5-5", {"cache_read_input_tokens": 10_000})
    assert cached == pytest.approx(fresh * 0.05)


def test_long_haiku_prompt_uses_the_higher_price():
    short = cost_usd("claude-haiku-5-5", {"input_tokens": 100_000, "output_tokens": 1_000})
    long = cost_usd(
        "claude-haiku-5-5", {"input_tokens": 60_000, "cache_read_input_tokens": 60_000, "output_tokens": 1_000}
    )
    assert short == pytest.approx((100_000 * 0.10 + 1_000 * 0.50) / MILLION)
    assert long == pytest.approx((60_000 * 0.50 + 60_000 * 0.05 + 1_000 * 2.50) / MILLION)


def test_unknown_model_is_charged_the_top_price():
    assert cost_usd("claude-something-new", FULL) == pytest.approx(cost_usd("claude-opus-5-5", FULL))


def test_own_key_bypasses_an_exceeded_budget():
    key, own = choose_key(
        own_key="sk-own", shared_key="sk-shared", is_admin=False, spent=9.0, budget=5.0, today=date(2026, 10, 18)
    )
    assert (key, own) == ("sk-own", True)


def test_own_key_works_without_a_shared_key():
    assert choose_key(
        own_key="sk-own", shared_key="", is_admin=False, spent=0, budget=0, today=date(2026, 10, 18)
    ) == ("sk-own", True)


def test_admin_has_no_limit():
    key, own = choose_key(
        own_key=None, shared_key="sk-shared", is_admin=True, spent=100.0, budget=5.0, today=date(2026, 10, 18)
    )
    assert (key, own) == ("sk-shared", False)


def test_under_budget_uses_the_shared_key():
    assert choose_key(
        own_key=None, shared_key="sk-shared", is_admin=False, spent=4.99, budget=5.0, today=date(2026, 10, 18)
    ) == ("sk-shared", False)


def test_at_budget_raises_with_next_months_reset():
    with pytest.raises(BudgetExceeded) as caught:
        choose_key(
            own_key="", shared_key="sk-shared", is_admin=False, spent=5.0, budget=5.0, today=date(2026, 10, 18)
        )
    err = caught.value
    assert (err.spent, err.budget, err.resets_on) == (5.0, 5.0, date(2026, 11, 1))
    assert str(err) == (
        "You've used this month's AI allowance. It resets on 1 November, "
        "or add your own Anthropic key in Settings."
    )


def test_december_resets_on_first_of_january():
    with pytest.raises(BudgetExceeded) as caught:
        choose_key(
            own_key=None, shared_key="sk-shared", is_admin=False, spent=7.0, budget=5.0, today=date(2026, 12, 31)
        )
    assert caught.value.resets_on == date(2027, 1, 1)
    assert "resets on 1 January" in str(caught.value)


def test_reset_date_follows_the_app_timezone(monkeypatch):
    monkeypatch.setattr(config, "TIMEZONE", "Europe/Athens")
    # 22:30 UTC on 31 December is already 1 January in Athens, so the reset is 1 February.
    late = datetime(2026, 12, 31, 22, 30, tzinfo=timezone.utc)
    with pytest.raises(BudgetExceeded) as caught:
        choose_key(own_key=None, shared_key="sk-shared", is_admin=False, spent=5.0, budget=5.0, today=late)
    assert caught.value.resets_on == date(2027, 2, 1)


def test_no_keys_at_all_errors():
    with pytest.raises(NoAPIKey, match="Anthropic key"):
        choose_key(own_key=None, shared_key="", is_admin=True, spent=0, budget=5.0, today=date(2026, 10, 18))


def test_month_bounds_span_the_month_in_the_app_timezone():
    tz = ZoneInfo(config.TIMEZONE)
    assert month_bounds(date(2026, 10, 18)) == (datetime(2026, 10, 1, tzinfo=tz), datetime(2026, 11, 1, tzinfo=tz))
    assert month_bounds(date(2026, 12, 5)) == (datetime(2026, 12, 1, tzinfo=tz), datetime(2027, 1, 1, tzinfo=tz))

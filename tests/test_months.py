"""Pay months: what every total, budget and pace in ebby is counted over.

A pay month runs from one payday to the day before the next, keyed by the calendar month it mostly covers. Pay
due on a weekend arrives the Friday before. The dates below are real 2026 weekdays.
"""

import pytest

from app.data import db
from app.domain import insights


@pytest.fixture
def paid_on(users):
    """Sets the pay day for the duration of a test."""
    with db.as_user(users["a"]):
        yield insights.set_payday
        insights._paydays.clear()


def test_payday_1_is_the_calendar_month(paid_on):
    paid_on(1)
    assert insights.month_bounds("2026-10") == ("2026-10-01", "2026-11-01")
    assert insights.month_bounds("2026-12") == ("2026-12-01", "2027-01-01")


def test_late_payday_starts_the_next_month_and_moves_off_weekends(paid_on):
    paid_on(25)
    # 25 Sep 2026 is a Friday; 25 Oct is a Sunday, so October's pay lands Friday the 23rd.
    assert insights.month_bounds("2026-10") == ("2026-09-25", "2026-10-23")
    assert insights.month_bounds("2026-11") == ("2026-10-23", "2026-11-25")


def test_early_payday_starts_its_own_month(paid_on):
    paid_on(10)
    # 10 Oct 2026 is a Saturday: paid Friday the 9th.
    assert insights.month_bounds("2026-10") == ("2026-10-09", "2026-11-10")


def test_last_working_day(paid_on):
    paid_on("last")
    # 30 Sep 2026 is a Wednesday; 31 Oct is a Saturday, so Friday the 30th.
    assert insights.month_bounds("2026-10") == ("2026-09-30", "2026-10-30")


def test_a_payday_past_the_months_end_is_its_last_day(paid_on):
    paid_on(31)
    # February 2026 ends on Saturday the 28th: paid Friday the 27th.
    assert insights.month_bounds("2026-03") == ("2026-02-27", "2026-03-31")


def test_which_pay_month_a_day_is_in(paid_on):
    paid_on(25)
    assert insights.month_of("2026-10-22") == "2026-10"
    assert insights.month_of("2026-10-23") == "2026-11"  # payday itself opens the next month
    assert insights.month_of("2026-09-24") == "2026-09"
    paid_on(1)
    assert insights.month_of("2026-10-31") == "2026-10"


def test_months_shift_across_years():
    assert insights.shift("2026-01", -1) == "2025-12"
    assert insights.shift("2026-12", 1) == "2027-01"
    assert insights.shift("2026-10", -18) == "2025-04"


def test_a_months_limit_scales_the_budgets_and_adds_up_to_it():
    plan = {"budgets": {"groceries": 400, "eating_out": 200, "delivery": 100}, "limits": {"2026-10": 1000 / 3}}
    scaled = insights.budgets_for(plan, "2026-10")
    assert round(sum(scaled.values()), 2) == round(1000 / 3, 2)
    assert scaled["groceries"] > scaled["eating_out"] > scaled["delivery"]  # in proportion
    assert insights.budgets_for(plan, "2026-11") == plan["budgets"]  # other months: the plan itself
    assert insights.budgets_for(None, "2026-10") == {}

"""The one place ebby reads the clock.

EBBY_NOW pins it to a moment (an ISO time such as 2026-10-20T09:00:00+03:00), so tests see the same day every
run, and so does any other implementation of the API run against the same tests. Read on every call, so a test
can change it.
"""

import os
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from app import config


def now() -> datetime:
    """Now, in UTC."""
    pinned = os.environ.get("EBBY_NOW")
    return datetime.fromisoformat(pinned).astimezone(timezone.utc) if pinned else datetime.now(timezone.utc)


def local_now() -> datetime:
    """Now where the people using ebby live (TIMEZONE)."""
    return now().astimezone(ZoneInfo(config.TIMEZONE))


def today() -> date:
    """Today where the people using ebby live: what pay months, budgets and goals count from."""
    return local_now().date()


def server_today() -> date:
    """Today on the server's own clock, where the code has always read that (date.today())."""
    return now().astimezone().date()

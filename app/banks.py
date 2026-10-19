"""The banks a person can connect: every one Enable Banking supports in the country, for personal accounts.

The list is public and the same for everyone, so it's fetched with whoever asks first and kept a day.
In restricted mode a bank only works if its accounts are linked to that person's own application.
"""

import threading
import time
from urllib.parse import quote

from . import config, credentials

DAY = 24 * 3600
# What Enable Banking listed for Greece (personal accounts) in October 2026, for the demo, which has no app of its own.
DEMO_BANKS = ["Airwallex", "Alpha Bank", "bunq", "Credia Bank", "DiPocket", "Epirus Bank", "Eurobank", "Genome", "iBanFirst",
              "N26", "National Bank of Greece", "Optima bank", "PayPal", "Piraeus Bank", "Revolut", "Snappi", "Trade Republic", "Wise"]
_cache: dict[str, tuple[float, list[dict]]] = {}
_lock = threading.Lock()


def available() -> list[dict]:
    """[{name, logo, beta, consent_days}], sorted by name. Raises credentials.MissingCredential before
    the person has given the app their Enable Banking keys, EnableBankingError if it can't be reached."""
    country = config.COUNTRY
    if config.DEMO:
        return [{"name": n, "logo": f"https://enablebanking.com/brands/GR/{quote(n)}/", "beta": True, "consent_days": 180}
                for n in sorted(DEMO_BANKS, key=str.lower)]
    with _lock:
        hit = _cache.get(country)
    if hit and time.time() - hit[0] < DAY:
        return hit[1]
    banks = sorted(({
        "name": b["name"],
        "logo": b.get("logo"),
        "beta": bool(b.get("beta")),
        "consent_days": int(b.get("maximum_consent_validity") or 0) // 86400 or None,
    } for b in credentials.client().aspsps(country) if "personal" in (b.get("psu_types") or ["personal"])),
        key=lambda b: b["name"].lower())
    with _lock:
        _cache[country] = (time.time(), banks)
    return banks


def find(name: str) -> dict | None:
    return next((b for b in available() if b["name"] == name), None)

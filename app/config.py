import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"'))


_load_env_file()

DATA_DIR = Path(os.path.expanduser(os.environ.get("DATA_DIR", str(ROOT / "data"))))
# Postgres. The app connects as a role that owns nothing, so row-level security always applies to it;
# the owner URL runs migrations and creates that role (with the password in DATABASE_URL) if it's missing.
DATABASE_URL = os.environ.get("DATABASE_URL", "")
DATABASE_OWNER_URL = os.environ.get("DATABASE_OWNER_URL", "")
# Made the admin on first start when there's none yet.
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip().lower()
WEB_DIST = ROOT / "web" / "dist"

# The single-user app's Enable Banking application. Only import-sqlite reads these: it becomes the
# imported person's own credential. Everyone else, a fresh admin included, uploads theirs in onboarding.
APP_ID = os.environ.get("EB_APP_ID", "")
KEY_PATH = Path(os.path.expanduser(os.environ.get("EB_KEY_PATH", str(DATA_DIR / "key.pem"))))
REDIRECT_URL = os.environ.get("EB_REDIRECT_URL", "https://localhost/eb-callback")
# The CLI's `connect` default. The app offers every bank Enable Banking has in COUNTRY (app/banks.py).
BANK = os.environ.get("EB_BANK", "Alpha Bank")
COUNTRY = os.environ.get("EB_COUNTRY", "GR")
CONSENT_DAYS = int(os.environ.get("EB_CONSENT_DAYS", "180"))

SYNC_HOURS = float(os.environ.get("SYNC_HOURS", "6"))
SYNC_LOOKBACK_DAYS = int(os.environ.get("SYNC_LOOKBACK_DAYS", "14"))
# Only read by import-sqlite: your names now live in each person's settings (owner_names).
OWNER_NAMES = [n.strip() for n in os.environ.get("OWNER_NAMES", "").split(",") if n.strip()]
# Optional: protects the dashboard with HTTP basic auth (any username). For local/LAN use.
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
# Google sign-in (app/auth.py; it also reads GOOGLE_CLIENT_SECRET, SESSION_SECRET and PUBLIC_URL).
# Set, it's how requests find their user. Unset, only a local run (PUBLIC_URL on localhost) serves data,
# as the admin; anywhere else the app refuses rather than hand the admin's money to anyone.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")
PUBLIC_URL = os.environ.get("PUBLIC_URL", "http://localhost:8000").rstrip("/")
LOCAL = PUBLIC_URL.startswith("http://localhost")

# The demo (app/demo.py, scripts/make-demo.sh): banks come from a built-in list and can't be connected.
DEMO = os.environ.get("DEMO", "") == "1"

# Web push (cool-down alerts). Generated once and kept in DATA_DIR unless provided.
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT") or PUBLIC_URL
TIMEZONE = os.environ.get("TZ_NAME", "Europe/Athens")
# Weekly read and on-demand insights. Without a key the app runs without them.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
# Needed when the key isn't scoped to one workspace (the API then asks which workspace to bill).
ANTHROPIC_WORKSPACE_ID = os.environ.get("ANTHROPIC_WORKSPACE_ID", "")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-opus-5-5")
# The chat and the sorter's guesses run often and need little, so they default to the cheapest model;
# Settings can switch them to another (ai.assistant_model). Reads and explanations keep the model above.
ASSISTANT_MODEL = os.environ.get("ASSISTANT_MODEL", "claude-haiku-5-5")
ASSISTANT_MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"}

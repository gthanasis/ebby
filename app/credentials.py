"""Each person's own keys: their Enable Banking app (ID + private key) and optionally an Anthropic key.

Stored sealed by vault (AES-GCM, bound to the person and the kind), checked against the service before
they're kept, and never sent back: the browser only ever sees public_info.
"""

import json
import threading
from datetime import datetime, timezone

import anthropic

from . import config, db, vault
from .enable_banking import Client, EnableBankingError

_clients: dict[int, Client] = {}  # per person; dropped whenever their keys change
_lock = threading.Lock()


class MissingCredential(Exception):
    """This person hasn't given the app their Enable Banking keys yet."""


def store(conn, kind: str, secret: dict, public_info: dict):
    """Seals and keeps a key for the current person. Callers check it works first."""
    sealed = vault.encrypt(json.dumps(secret).encode(), user_id=db.current_user(), kind=kind)
    conn.execute("""
        INSERT INTO credentials(kind, key_id, nonce, ciphertext, public_info, verified_at) VALUES(?, ?, ?, ?, ?, now())
        ON CONFLICT(user_id, kind) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce,
          ciphertext = excluded.ciphertext, public_info = excluded.public_info, verified_at = excluded.verified_at
    """, (kind, sealed.key_id, sealed.nonce, sealed.ciphertext, json.dumps(public_info)))


def _load(conn, kind: str) -> dict | None:
    row = conn.execute("SELECT key_id, nonce, ciphertext FROM credentials WHERE kind = ?", (kind,)).fetchone()
    if not row:
        return None
    sealed = vault.Sealed(row["key_id"], bytes(row["nonce"]), bytes(row["ciphertext"]))
    secret = json.loads(vault.decrypt(sealed, user_id=db.current_user(), kind=kind))
    if vault.needs_rotation(sealed):
        store(conn, kind, secret, public(conn).get(kind) or {})
    return secret


def public(conn) -> dict[str, dict]:
    """What's safe to show: {kind: public_info + verified_at}."""
    return {r["kind"]: {**r["public_info"], "verified_at": r["verified_at"].isoformat() if r["verified_at"] else None}
            for r in conn.execute("SELECT kind, public_info, verified_at FROM credentials")}


def save_enable_banking(app_id: str, pem: bytes) -> dict:
    """Checks the keys with Enable Banking before keeping them. Raises ValueError with a message to show."""
    app_id = vault.validate_app_id(app_id)
    fingerprint = vault.validate_pem(pem)
    client = Client(app_id, pem)
    try:
        client.aspsps(config.COUNTRY)
    except EnableBankingError as e:
        raise ValueError(f"Enable Banking didn't accept these keys ({e.message}). Check the application ID "
                         "matches the .pem, and that the application is active.") from e
    info = {"app_id": app_id, "key_fingerprint": fingerprint}
    with db.connect() as conn:
        store(conn, "enable_banking", {"app_id": app_id, "pem": pem.decode()}, info)
    forget_client()
    return {**info, "verified_at": datetime.now(timezone.utc).isoformat()}


def save_anthropic(api_key: str) -> dict:
    api_key = api_key.strip()
    try:
        # Free, and fails on a bad key.
        anthropic.Anthropic(api_key=api_key).messages.count_tokens(
            model=config.ASSISTANT_MODEL, messages=[{"role": "user", "content": "hi"}])
    except anthropic.AuthenticationError as e:
        raise ValueError("Anthropic didn't accept that key.") from e
    except anthropic.APIError as e:
        raise ValueError(f"Couldn't check the key with Anthropic ({e.__class__.__name__}). Try again.") from e
    info = {"masked": vault.mask_api_key(api_key)}
    with db.connect() as conn:
        store(conn, "anthropic", {"api_key": api_key}, info)
    return info


def adopt_env_key(user_id: int) -> bool:
    """For import-sqlite: the single-user app's Enable Banking application (EB_APP_ID + key.pem) becomes
    the imported person's own, since their bank sessions were made with it. Not checked live: it already
    worked. Does nothing once they have keys of their own. True if it stored them."""
    if not (config.APP_ID and config.KEY_PATH.exists()):
        return False
    with db.as_user(user_id), db.connect() as conn:
        if conn.execute("SELECT 1 FROM credentials WHERE kind = 'enable_banking'").fetchone():
            return False
        pem = config.KEY_PATH.read_bytes()
        store(conn, "enable_banking", {"app_id": config.APP_ID, "pem": pem.decode()},
              {"app_id": config.APP_ID, "key_fingerprint": vault.validate_pem(pem)})
    return True


def anthropic_key() -> str | None:
    with db.connect() as conn:
        secret = _load(conn, "anthropic")
    return secret["api_key"] if secret else None


def remove(kind: str):
    with db.connect() as conn:
        conn.execute("DELETE FROM credentials WHERE kind = ?", (kind,))
        if kind == "enable_banking":
            # Sessions were made with that app; they won't work with another one.
            conn.execute("""UPDATE connections SET session_id = NULL,
                            last_error = '{"message": "Bank access was removed", "reconnect": true}'""")
    forget_client()


def client() -> Client:
    """The current person's Enable Banking client, built from their own keys."""
    user = db.current_user()
    with _lock:
        if user not in _clients:
            with db.connect() as conn:
                secret = _load(conn, "enable_banking")
            if not secret:
                raise MissingCredential("Add your Enable Banking application first.")
            _clients[user] = Client(secret["app_id"], secret["pem"].encode())
        return _clients[user]


def forget_client():
    with _lock:
        _clients.pop(db.current_user(), None)

"""Encrypting each person's bank and API credentials, and checking uploads before they're stored.

A leaked database dump or backup holds only ciphertext: the master key lives in the environment.
The associated data ties every ciphertext to its user and kind, so a row copied onto another
user can't be decrypted there.
"""

import base64
import binascii
import hashlib
import os
import uuid
from dataclasses import dataclass

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAX_PEM_BYTES = 16 * 1024
NOT_A_KEY = "That file isn't a private key. Upload the .pem Enable Banking gave you."


@dataclass(frozen=True)
class Sealed:
    key_id: str
    nonce: bytes
    ciphertext: bytes


def _decode_key(value: str, name: str) -> bytes:
    try:
        key = base64.b64decode(value.strip(), validate=True)
    except (binascii.Error, ValueError):
        raise RuntimeError(f"{name} isn't valid base64") from None
    if len(key) != 32:
        raise RuntimeError(f"{name} must be 32 bytes, base64 encoded")
    return key


def _key_id(key: bytes) -> str:
    return hashlib.sha256(key).hexdigest()[:8]


def _current_key() -> bytes:
    value = os.environ.get("CREDENTIALS_KEY")
    if not value:
        raise RuntimeError("CREDENTIALS_KEY isn't set")
    return _decode_key(value, "CREDENTIALS_KEY")


def _keys() -> dict[str, bytes]:
    """Every key that can decrypt, by id; read on each call so tests and rotations take effect."""
    keys = {}
    for value in os.environ.get("CREDENTIALS_OLD_KEYS", "").split(","):
        if value.strip():
            key = _decode_key(value, "CREDENTIALS_OLD_KEYS")
            keys[_key_id(key)] = key
    current = _current_key()
    keys[_key_id(current)] = current
    return keys


def _aad(user_id: int, kind: str) -> bytes:
    return f"{user_id}:{kind}".encode()


def encrypt(plaintext: bytes, *, user_id: int, kind: str) -> Sealed:
    key = _current_key()
    nonce = os.urandom(12)
    return Sealed(_key_id(key), nonce, AESGCM(key).encrypt(nonce, plaintext, _aad(user_id, kind)))


def decrypt(sealed: Sealed, *, user_id: int, kind: str) -> bytes:
    """Raises cryptography's InvalidTag if it was tampered with or belongs to another user or kind."""
    key = _keys().get(sealed.key_id)
    if key is None:
        raise RuntimeError(f"No credentials key with id {sealed.key_id}")
    return AESGCM(key).decrypt(sealed.nonce, sealed.ciphertext, _aad(user_id, kind))


def needs_rotation(sealed: Sealed) -> bool:
    return sealed.key_id != _key_id(_current_key())


def validate_pem(data: bytes) -> str:
    """Returns a short fingerprint of the key's public half, safe to show and store in the clear."""
    if len(data) > MAX_PEM_BYTES:
        raise ValueError(NOT_A_KEY)
    try:
        key = serialization.load_pem_private_key(data, password=None)
    except (ValueError, TypeError):
        raise ValueError(NOT_A_KEY) from None
    if not isinstance(key, rsa.RSAPrivateKey):
        raise ValueError(NOT_A_KEY)
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return hashlib.sha256(der).hexdigest()[:16]


def validate_app_id(s: str) -> str:
    try:
        return str(uuid.UUID(s.strip()))
    except ValueError:
        raise ValueError("That isn't an application ID. Copy it from the Enable Banking control panel.") from None


def mask_api_key(key: str) -> str:
    return f"key ending …{key.strip()[-4:]}"

import base64
import os
from dataclasses import replace

import pytest
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from app.data import vault


def _new_key() -> str:
    return base64.b64encode(os.urandom(32)).decode()


def _pem(key) -> bytes:
    return key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


@pytest.fixture(autouse=True)
def key(monkeypatch):
    k = _new_key()
    monkeypatch.setenv("CREDENTIALS_KEY", k)
    monkeypatch.delenv("CREDENTIALS_OLD_KEYS", raising=False)
    return k


def test_round_trip():
    sealed = vault.encrypt(b"secret", user_id=1, kind="enable_banking")
    assert sealed.ciphertext != b"secret" and len(sealed.nonce) == 12
    assert vault.decrypt(sealed, user_id=1, kind="enable_banking") == b"secret"
    assert vault.encrypt(b"secret", user_id=1, kind="enable_banking").nonce != sealed.nonce
    assert not vault.needs_rotation(sealed)


@pytest.mark.parametrize("user_id, kind", [(2, "enable_banking"), (1, "anthropic")])
def test_other_user_or_kind_fails(user_id, kind):
    sealed = vault.encrypt(b"secret", user_id=1, kind="enable_banking")
    with pytest.raises(InvalidTag):
        vault.decrypt(sealed, user_id=user_id, kind=kind)


def test_tampered_ciphertext_fails():
    sealed = vault.encrypt(b"secret", user_id=1, kind="enable_banking")
    flipped = bytes([sealed.ciphertext[0] ^ 1]) + sealed.ciphertext[1:]
    with pytest.raises(InvalidTag):
        vault.decrypt(replace(sealed, ciphertext=flipped), user_id=1, kind="enable_banking")


def test_old_key_still_decrypts(monkeypatch, key):
    sealed = vault.encrypt(b"secret", user_id=1, kind="anthropic")
    monkeypatch.setenv("CREDENTIALS_KEY", _new_key())
    monkeypatch.setenv("CREDENTIALS_OLD_KEYS", f"{_new_key()}, {key}")
    assert vault.needs_rotation(sealed)
    assert vault.decrypt(sealed, user_id=1, kind="anthropic") == b"secret"


def test_removed_key_cannot_decrypt(monkeypatch):
    sealed = vault.encrypt(b"secret", user_id=1, kind="anthropic")
    monkeypatch.setenv("CREDENTIALS_KEY", _new_key())
    with pytest.raises(RuntimeError, match="No credentials key"):
        vault.decrypt(sealed, user_id=1, kind="anthropic")


@pytest.mark.parametrize("value, message", [
    (None, "isn't set"),
    ("not base64!", "isn't valid base64"),
    (base64.b64encode(b"short").decode(), "must be 32 bytes"),
])
def test_missing_or_invalid_key(monkeypatch, value, message):
    if value is None:
        monkeypatch.delenv("CREDENTIALS_KEY")
    else:
        monkeypatch.setenv("CREDENTIALS_KEY", value)
    with pytest.raises(RuntimeError, match=message) as err:
        vault.encrypt(b"secret", user_id=1, kind="anthropic")
    if value:
        assert value not in str(err.value)


def test_pem_accepted():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    fingerprint = vault.validate_pem(_pem(key))
    assert len(fingerprint) == 16 and ":" not in fingerprint
    traditional = key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption())
    assert vault.validate_pem(traditional) == fingerprint


@pytest.mark.parametrize("data", [
    b"hello",
    b"",
    b"-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n",
    _pem(ec.generate_private_key(ec.SECP256R1())),
    b"x" * (16 * 1024 + 1),
])
def test_pem_rejected(data):
    with pytest.raises(ValueError, match="isn't a private key"):
        vault.validate_pem(data)


def test_oversize_pem_rejected_even_if_valid():
    pem = _pem(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    with pytest.raises(ValueError):
        vault.validate_pem(pem + b"\n" * (16 * 1024))


def test_app_id():
    assert vault.validate_app_id(" 3F2504E0-4F89-11D3-9A0C-0305E82C3301 ") \
        == "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    for bad in ["", "not-a-uuid", "3f2504e0-4f89-11d3-9a0c"]:
        with pytest.raises(ValueError):
            vault.validate_app_id(bad)


def test_mask_api_key():
    assert vault.mask_api_key("sk-ant-api03-xyzxyza1b2") == "key ending …a1b2"

/**
 * Encrypting each person's bank and API credentials, and checking uploads before they're stored.
 *
 * A leaked database dump or backup holds only ciphertext: the master key lives in the environment. The associated
 * data ties every ciphertext to its user and kind, so a row copied onto another user can't be decrypted there.
 * Byte for byte what the Python app stored: AES-256-GCM, the 16-byte tag after the ciphertext.
 */

import { secrets } from "../config.js";
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto";

export const MAX_PEM_BYTES = 16 * 1024;
export const NOT_A_KEY = "That file isn't a private key. Upload the .pem Enable Banking gave you.";

export interface Sealed { keyId: string; nonce: Buffer; ciphertext: Buffer }

function decodeKey(value: string, name: string): Buffer {
  const v = value.trim();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(v) || v.length % 4) throw new Error(`${name} isn't valid base64`);
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
  return key;
}

const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

function currentKey(): Buffer {
  const value = secrets.CREDENTIALS_KEY;
  if (!value) throw new Error("CREDENTIALS_KEY isn't set");
  return decodeKey(value, "CREDENTIALS_KEY");
}

/** Every key that can decrypt, by id; read on each call so tests and rotations take effect. */
function keys(): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const value of secrets.CREDENTIALS_OLD_KEYS) {
    const k = decodeKey(value, "CREDENTIALS_OLD_KEYS");
    out.set(keyId(k), k);
  }
  const current = currentKey();
  out.set(keyId(current), current);
  return out;
}

const aad = (userId: number, kind: string) => Buffer.from(`${userId}:${kind}`);

export function encrypt(plaintext: Buffer, userId: number, kind: string): Sealed {
  const key = currentKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(userId, kind));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { keyId: keyId(key), nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** Throws if it was tampered with or belongs to another user or kind. */
export function decrypt(sealed: Sealed, userId: number, kind: string): Buffer {
  const key = keys().get(sealed.keyId);
  if (!key) throw new Error(`No credentials key with id ${sealed.keyId}`);
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.nonce);
  decipher.setAAD(aad(userId, kind));
  decipher.setAuthTag(sealed.ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, -16)), decipher.final()]);
}

export const needsRotation = (sealed: Sealed) => sealed.keyId !== keyId(currentKey());

/** A short fingerprint of the key's public half, safe to show and store in the clear. Throws Error(NOT_A_KEY). */
export function validatePem(data: Buffer): string {
  if (data.length > MAX_PEM_BYTES) throw new Error(NOT_A_KEY);
  let key;
  try {
    key = createPrivateKey({ key: data, format: "pem" });
  } catch {
    throw new Error(NOT_A_KEY);
  }
  if (key.asymmetricKeyType !== "rsa") throw new Error(NOT_A_KEY);
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

/** Python's str(uuid.UUID(s)): braces, urn:uuid: and dashes optional, written back canonical. */
export function validateAppId(s: string): string {
  const hex = s.trim().replace(/^urn:uuid:/i, "").replace(/^\{|\}$/g, "").replaceAll("-", "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error("That isn't an application ID. Copy it from the Enable Banking control panel.");
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const maskApiKey = (key: string) => `key ending …${key.trim().slice(-4)}`;

/**
 * Each person's own keys: their Enable Banking app (ID + private key) and optionally an Anthropic key.
 *
 * Stored sealed by vault (AES-GCM, bound to the person and the kind), checked against the service before they're
 * kept, and never sent back: the browser only ever sees public_info.
 */

import Anthropic from "@anthropic-ai/sdk";

import * as clock from "../clock.js";
import { config } from "../config.js";
import { Client, EnableBankingError } from "../integrations/enable_banking.js";
import { isoUtc, pyDumps } from "../py.js";
import * as db from "./db.js";
import type { Conn } from "./db.js";
import * as vault from "./vault.js";

export const _clients = new Map<number, Client>();  // per person; dropped whenever their keys change

/** This person hasn't given the app their Enable Banking keys yet. */
export class MissingCredential extends Error {}

/** Seals and keeps a key for the current person. Callers check it works first. */
export async function store(conn: Conn, kind: string, secret: unknown, publicInfo: unknown) {
  const sealed = vault.encrypt(Buffer.from(pyDumps(secret)), db.currentUser()!, kind);
  await conn.execute(`
    INSERT INTO credentials(kind, key_id, nonce, ciphertext, public_info, verified_at) VALUES(?, ?, ?, ?, ?, now())
    ON CONFLICT(user_id, kind) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce,
      ciphertext = excluded.ciphertext, public_info = excluded.public_info, verified_at = excluded.verified_at
  `, [kind, sealed.keyId, sealed.nonce, sealed.ciphertext, JSON.stringify(publicInfo)]);
}

async function load(conn: Conn, kind: string): Promise<any | null> {
  const row = (await conn.execute("SELECT key_id, nonce, ciphertext FROM credentials WHERE kind = ?", [kind])).one();
  if (!row) return null;
  const sealed = { keyId: row.key_id, nonce: row.nonce, ciphertext: row.ciphertext };
  const secret = JSON.parse(vault.decrypt(sealed, db.currentUser()!, kind).toString());
  if (vault.needsRotation(sealed)) await store(conn, kind, secret, (await publicInfo(conn))[kind] ?? {});
  return secret;
}

/** What's safe to show: {kind: public_info + verified_at}. */
export async function publicInfo(conn: Conn): Promise<Record<string, any>> {
  return Object.fromEntries((await conn.execute("SELECT kind, public_info, verified_at FROM credentials")).rows
    .map((r) => [r.kind, { ...r.public_info, verified_at: r.verified_at ?? null }]));
}

/** Checks the keys with Enable Banking before keeping them. Throws Error with a message to show. */
export async function saveEnableBanking(appIdIn: string, pem: Buffer): Promise<Record<string, unknown>> {
  const appId = vault.validateAppId(appIdIn);
  const fingerprint = vault.validatePem(pem);
  try {
    await new Client(appId, pem).aspsps(config.COUNTRY);
  } catch (e) {
    if (e instanceof EnableBankingError) {
      throw new Error(`Enable Banking didn't accept these keys (${e.message}). Check the application ID matches the .pem, and that the application is active.`);
    }
    throw e;
  }
  const info = { app_id: appId, key_fingerprint: fingerprint };
  await db.connect((conn) => store(conn, "enable_banking", { app_id: appId, pem: pem.toString() }, info));
  forgetClient();
  return { ...info, verified_at: isoUtc(clock.now()) };
}

export async function saveAnthropic(apiKeyIn: string): Promise<Record<string, unknown>> {
  const apiKey = apiKeyIn.trim();
  try {
    // Free, and fails on a bad key.
    await new Anthropic({ apiKey }).messages.countTokens({ model: config.ASSISTANT_MODEL, messages: [{ role: "user", content: "hi" }] });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error("Anthropic didn't accept that key.");
    if (e instanceof Anthropic.APIError) throw new Error(`Couldn't check the key with Anthropic (${e.constructor.name}). Try again.`);
    throw e;
  }
  const info = { masked: vault.maskApiKey(apiKey) };
  await db.connect((conn) => store(conn, "anthropic", { api_key: apiKey }, info));
  return info;
}

export async function anthropicKey(): Promise<string | null> {
  const secret = await db.connect((conn) => load(conn, "anthropic"));
  return secret ? secret.api_key : null;
}

export async function remove(kind: string) {
  await db.connect(async (conn) => {
    await conn.execute("DELETE FROM credentials WHERE kind = ?", [kind]);
    if (kind === "enable_banking") {
      // Sessions were made with that app; they won't work with another one.
      await conn.execute(`UPDATE connections SET session_id = NULL,
                          last_error = '{"message": "Bank access was removed", "reconnect": true}'`);
    }
  });
  forgetClient();
}

/** The current person's Enable Banking client, built from their own keys. */
export async function client(): Promise<Client> {
  const user = db.currentUser()!;
  const hit = _clients.get(user);
  if (hit) return hit;
  const secret = await db.connect((conn) => load(conn, "enable_banking"));
  if (!secret) throw new MissingCredential("Add your Enable Banking application first.");
  const made = new Client(secret.app_id, Buffer.from(secret.pem));
  _clients.set(user, made);
  return made;
}

export function forgetClient() {
  _clients.delete(db.currentUser()!);
}

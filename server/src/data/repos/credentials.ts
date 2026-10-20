/** The credentials table: each person's keys, sealed by vault. */

import type { Conn } from "../db.js";

/** Keeps a sealed key, replacing the one of its kind, verified now. */
export async function upsert(conn: Conn, kind: string, keyId: string, nonce: Buffer, ciphertext: Buffer, publicInfo: string) {
  await conn.execute(`
    INSERT INTO credentials(kind, key_id, nonce, ciphertext, public_info, verified_at) VALUES(?, ?, ?, ?, ?, now())
    ON CONFLICT(user_id, kind) DO UPDATE SET key_id = excluded.key_id, nonce = excluded.nonce,
      ciphertext = excluded.ciphertext, public_info = excluded.public_info, verified_at = excluded.verified_at
  `, [kind, keyId, nonce, ciphertext, publicInfo]);
}

export async function sealed(conn: Conn, kind: string): Promise<{ key_id: string; nonce: Buffer; ciphertext: Buffer } | undefined> {
  return (await conn.execute<{ key_id: string; nonce: Buffer; ciphertext: Buffer }>("SELECT key_id, nonce, ciphertext FROM credentials WHERE kind = ?", [kind])).one();
}

/** What's safe to show of each key. */
export async function publicInfo(conn: Conn): Promise<{ kind: string; public_info: any; verified_at: string | null }[]> {
  return (await conn.execute<{ kind: string; public_info: any; verified_at: string | null }>("SELECT kind, public_info, verified_at FROM credentials")).rows;
}

export async function remove(conn: Conn, kind: string) {
  await conn.execute("DELETE FROM credentials WHERE kind = ?", [kind]);
}

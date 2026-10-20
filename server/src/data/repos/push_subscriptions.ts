/** The push_subscriptions table: one row per device that gets notifications. */

import { first, type Conn } from "../db.js";

/** Keeps a device's subscription, replacing the one for its endpoint. */
export async function upsert(conn: Conn, endpoint: string, subscription: string, createdAt: string) {
  await conn.execute(`
    INSERT INTO push_subscriptions(endpoint, subscription, created_at) VALUES(?, ?, ?)
    ON CONFLICT(user_id, endpoint) DO UPDATE SET subscription = excluded.subscription
  `, [endpoint, subscription, createdAt]);
}

export async function remove(conn: Conn, endpoint: string) {
  await conn.execute("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]);
}

export async function count(conn: Conn): Promise<number> {
  return first((await conn.execute("SELECT COUNT(*) FROM push_subscriptions")).one());
}

/** Every subscription as stored (JSON text). */
export async function all(conn: Conn): Promise<string[]> {
  return (await conn.execute<{ subscription: string }>("SELECT subscription FROM push_subscriptions")).rows.map((r) => r.subscription);
}

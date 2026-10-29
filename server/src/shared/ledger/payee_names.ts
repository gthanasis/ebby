/** The payee_names table: a person's own name for a payee, keyed by the payee as the bank's text gives it. */

import type { Conn } from "../db.js";

/** Names payee, replacing any name it had. */
export async function set(conn: Conn, payee: string, name: string) {
  await conn.db.insertInto("payee_names").values({ payee, name })
    .onConflict((oc) => oc.columns(["user_id", "payee"]).doUpdateSet((eb) => ({ name: eb.ref("excluded.name") })))
    .execute();
}

export async function remove(conn: Conn, payee: string) {
  await conn.db.deleteFrom("payee_names").where("payee", "=", payee).execute();
}

/** Every name, as payee → name. */
export async function all(conn: Conn): Promise<Record<string, string>> {
  return Object.fromEntries((await conn.db.selectFrom("payee_names").select(["payee", "name"]).execute()).map((r) => [r.payee, r.name]));
}

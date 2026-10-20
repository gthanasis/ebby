/** The rules table: a category per payee, or per payment (merchant "tx:<id>"). */

import type { Conn } from "../db.js";

/** Sets key's category, replacing any it had. */
export async function set(conn: Conn, merchant: string, category: string) {
  await conn.db.insertInto("rules").values({ merchant, category })
    .onConflict((oc) => oc.columns(["user_id", "merchant"]).doUpdateSet((eb) => ({ category: eb.ref("excluded.category") })))
    .execute();
}

/** Drops the per-payment rules of a payee's payments that now say the same as the payee's rule. */
export async function dropPaymentRulesMatching(conn: Conn, merchant: string, category: string) {
  await conn.execute(`DELETE FROM rules WHERE category = ? AND merchant IN (
                        SELECT 'tx:' || id FROM transactions WHERE merchant = ?)`, [category, merchant]);
}

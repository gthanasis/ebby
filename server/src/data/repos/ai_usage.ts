/** The ai_usage table: what each call to Claude cost. */

import type { Insertable } from "kysely";

import { first, type Conn } from "../db.js";
import type { AiUsage } from "../../types/db.js";

/** What counts against the allowance since a moment: calls on the owner's key. */
export async function spentOnOwnerKey(conn: Conn, since: Date | string): Promise<number> {
  return first((await conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE at >= ? AND NOT own_key", [since])).one());
}

export async function add(conn: Conn, u: Pick<Insertable<AiUsage>, "feature" | "model" | "input" | "cache_read" | "cache_write" | "output" | "cost_usd" | "own_key">) {
  await conn.db.insertInto("ai_usage").values(u).execute();
}

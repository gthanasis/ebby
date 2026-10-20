/** The ai_usage table: what each call to Claude cost. */

import { first, type Conn } from "../db.js";

/** What counts against the allowance since a moment: calls on the owner's key. */
export async function spentOnOwnerKey(conn: Conn, since: Date | string): Promise<number> {
  return first((await conn.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE at >= ? AND NOT own_key", [since])).one());
}

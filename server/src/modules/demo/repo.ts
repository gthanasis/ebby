/** Filling a person's tables with made-up data (the demo). */

import type { Conn } from "../../shared/db.js";

/** Empties a table of the current person's rows. */
export async function clearOwnRows(conn: Conn, table: string) {
  await conn.execute(`DELETE FROM ${table}`);  // row-level security: only the current user's own rows
}

/** The accounts table. */

import type { Conn, Row } from "../db.js";

/** Every account with how many payments it holds and the date of its oldest, for the status screen. */
export async function withCounts(conn: Conn): Promise<Row[]> {
  return (await conn.execute(
    "SELECT id, bank, name, is_card, last4, balance, balance_at, synced_at, "
    + "(SELECT COUNT(*) FROM transactions t WHERE t.account = a.id) AS transactions, "
    + "(SELECT MIN(date) FROM transactions t WHERE t.account = a.id) AS since "
    + "FROM accounts a ORDER BY bank, is_card, name")).rows;
}

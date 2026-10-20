/** The connections table: one row per bank a person has connected. */

import type { Conn } from "../db.js";

/** The bank a connection attempt was started for, by the state it was sent with. */
export const byAuthState = (conn: Conn, state: string): Promise<{ bank: string } | undefined> =>
  conn.db.selectFrom("connections").select("bank").where("auth_state", "=", state).executeTakeFirst();

/** Ends every bank session, marking each connection to be reconnected. */
export async function dropSessions(conn: Conn) {
  await conn.execute(`UPDATE connections SET session_id = NULL,
                          last_error = '{"message": "Bank access was removed", "reconnect": true}'`);
}

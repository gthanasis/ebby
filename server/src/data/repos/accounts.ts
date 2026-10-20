/** The accounts table. */

import type { NotNull } from "kysely";

import type { Conn, Row } from "../db.js";
import type { Account } from "../../types/entities.js";

/** Every account with how many payments it holds and the date of its oldest, for the status screen. */
export async function withCounts(conn: Conn): Promise<Row[]> {
  return (await conn.execute(
    "SELECT id, bank, name, is_card, last4, balance, balance_at, synced_at, "
    + "(SELECT COUNT(*) FROM transactions t WHERE t.account = a.id) AS transactions, "
    + "(SELECT MIN(date) FROM transactions t WHERE t.account = a.id) AS since "
    + "FROM accounts a ORDER BY bank, is_card, name")).rows;
}

/** Current accounts and pockets, the hand-kept cash account left out, for choosing savings. */
export async function own(conn: Conn, cashAccount: string): Promise<{ id: string; bank: string | null; name: string; is_card: number }[]> {
  return (await conn.execute<{ id: string; bank: string | null; name: string; is_card: number }>(
    "SELECT id, bank, name, is_card FROM accounts WHERE is_card = 0 AND id != ? ORDER BY bank, name", [cashAccount])).rows;
}

/** Adds the account cash logged by hand is kept in, if it isn't there yet. */
export async function ensureCash(conn: Conn, id: string) {
  await conn.execute(`INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, NULL, 'Cash', 0, NULL, 'Cash')
                      ON CONFLICT(user_id, id) DO NOTHING`, [id]);
}

/** A bank's accounts that can be fetched (they have a uid). */
export const syncable = (conn: Conn, bank: string): Promise<(Pick<Account, "id" | "is_card"> & { uid: string })[]> =>
  conn.db.selectFrom("accounts").select(["id", "uid", "is_card"]).where("uid", "is not", null).where("bank", "=", bank)
    .$narrowType<{ uid: NotNull }>().execute();

export async function setBalance(conn: Conn, id: string, balance: number | null, balanceAt: string, syncedAt: string) {
  await conn.db.updateTable("accounts").set({ balance, balance_at: balanceAt, synced_at: syncedAt }).where("id", "=", id).execute();
}

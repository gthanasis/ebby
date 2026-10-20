/** Cash: spending logged by hand, taken out of what was withdrawn. */

import { randomBytes } from "node:crypto";

import { type Conn, first, type Row } from "../data/db.js";
import { pyDumps, pyRound } from "../py.js";
import { CATEGORIES } from "./categories.js";
import { CASH_ACCOUNT } from "./constants.js";
import { monthBounds } from "./months.js";

/** Withdrawn this month vs what has been logged against it. */
export async function cashView(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const withdrawn = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND category = 'cash' AND account != ? AND amount < 0 AND duplicate_of IS NULL AND currency = 'EUR'`, [start, end, CASH_ACCOUNT])).one());
  const logged = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND account = ? AND status = 'CASH' AND amount < 0`, [start, end, CASH_ACCOUNT])).one());
  return { withdrawn: pyRound(withdrawn, 2), logged: pyRound(logged, 2), unaccounted: pyRound(Math.max(0, withdrawn - logged), 2) };
}

/** Records cash spending. Two rows: the spending in its category, and an equal credit in Cash, so the withdrawal
 * (already counted as Cash) shrinks by the same amount and the month's total doesn't change. */
export async function logCash(conn: Conn, amount: number, category: string, note: string, day: string): Promise<string> {
  await conn.execute(`INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, NULL, 'Cash', 0, NULL, 'Cash')
                      ON CONFLICT(user_id, id) DO NOTHING`, [CASH_ACCOUNT]);
  const key = randomBytes(6).toString("hex");
  note = note.trim() || CATEGORIES[category][0];
  const raw = pyDumps({ logged_by_hand: true, note });
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
                      VALUES(?, ?, ?, ?, 'EUR', 'CASH', ?, ?, NULL, ?, ?)`,
    [`cash:${key}`, CASH_ACCOUNT, day, -Math.abs(amount), `Cash: ${note}`, `Cash: ${note}`, category, raw]);
  // The offset never shows in lists (status OFFSET); it only reduces Cash.
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw, duplicate_of)
                      VALUES(?, ?, ?, ?, 'EUR', 'OFFSET', ?, '', NULL, 'cash', ?, NULL)`,
    [`cash:${key}:offset`, CASH_ACCOUNT, day, Math.abs(amount), `Logged from cash: ${note}`, raw]);
  return `cash:${key}`;
}

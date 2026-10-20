/** Cash: spending logged by hand, taken out of what was withdrawn. */

import { randomBytes } from "node:crypto";

import { type Conn, type Row } from "../data/db.js";
import * as accountsRepo from "../data/repos/accounts.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { pyDumps, pyRound } from "../py.js";
import { CATEGORIES } from "../core/categories.js";
import { CASH_ACCOUNT } from "../core/constants.js";
import { monthBounds } from "./months.js";

/** Withdrawn this month vs what has been logged against it. */
export async function cashView(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const withdrawn = -await transactionsRepo.cashWithdrawn(conn, start, end, CASH_ACCOUNT);
  const logged = -await transactionsRepo.cashLogged(conn, start, end, CASH_ACCOUNT);
  return { withdrawn: pyRound(withdrawn, 2), logged: pyRound(logged, 2), unaccounted: pyRound(Math.max(0, withdrawn - logged), 2) };
}

/** Records cash spending. Two rows: the spending in its category, and an equal credit in Cash, so the withdrawal
 * (already counted as Cash) shrinks by the same amount and the month's total doesn't change. */
export async function logCash(conn: Conn, amount: number, category: string, note: string, day: string): Promise<string> {
  await accountsRepo.ensureCash(conn, CASH_ACCOUNT);
  const key = randomBytes(6).toString("hex");
  note = note.trim() || CATEGORIES[category][0];
  const raw = pyDumps({ logged_by_hand: true, note });
  await transactionsRepo.addCash(conn, `cash:${key}`, CASH_ACCOUNT, day, -Math.abs(amount), `Cash: ${note}`, category, raw);
  // The offset never shows in lists (status OFFSET); it only reduces Cash.
  await transactionsRepo.addCashOffset(conn, `cash:${key}:offset`, CASH_ACCOUNT, day, Math.abs(amount), `Logged from cash: ${note}`, raw);
  return `cash:${key}`;
}

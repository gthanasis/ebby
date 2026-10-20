/** Cash: spending logged by hand, taken out of what was withdrawn. */

import { randomBytes } from "node:crypto";

import { type Conn } from "../../shared/db.js";
import * as accountsRepo from "../../shared/ledger/accounts.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { pyDumps } from "../../shared/utils/python.js";
import { CATEGORIES } from "../../shared/categories.js";
import { CASH_ACCOUNT } from "../../shared/constants.js";
import { monthBounds } from "../../shared/months.js";
import { type Cash, toCash } from "./converters.js";

/** Withdrawn this month vs what has been logged against it. */
export async function cashView(conn: Conn, month: string): Promise<Cash> {
  const [start, end] = monthBounds(month);
  const withdrawn = -await transactionsRepo.cashWithdrawn(conn, start, end, CASH_ACCOUNT);
  const logged = -await transactionsRepo.cashLogged(conn, start, end, CASH_ACCOUNT);
  return toCash(withdrawn, logged);
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

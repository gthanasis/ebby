/** Reading the transactions table for the overview and the transaction list. Spending sums use SPEND_SQL, so they
 * count what the rest of the app counts as spending. */

import { first, type Conn, type Row } from "../db.js";
import { SPEND_ARGS, SPEND_SQL } from "../../domain/spend_sql.js";

/** Spending in [start, end), as a positive sum. */
export async function spent(conn: Conn, start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL}`,
    [start, end, ...SPEND_ARGS])).one());
}

export async function spentByCategory(conn: Conn, start: string, end: string): Promise<Row[]> {
  return (await conn.execute(`
    SELECT category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY amount DESC
  `, [start, end, ...SPEND_ARGS])).rows;
}

export async function spentByDay(conn: Conn, start: string, end: string): Promise<Row[]> {
  return (await conn.execute(`
    SELECT date, -SUM(amount) AS amount FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY date ORDER BY date
  `, [start, end, ...SPEND_ARGS])).rows;
}

/** Spending and euro income per day in [start, end). */
export async function spentAndIncomeByDay(conn: Conn, start: string, end: string): Promise<{ date: string; spent: number; income: number }[]> {
  return (await conn.execute<{ date: string; spent: number; income: number }>(`
    SELECT date,
      -SUM(CASE WHEN ${SPEND_SQL} THEN amount ELSE 0 END) AS spent,
      SUM(CASE WHEN category = 'income' AND currency = 'EUR' THEN amount ELSE 0 END) AS income
    FROM transactions WHERE date >= ? AND date < ? GROUP BY date
  `, [...SPEND_ARGS, start, end])).rows;
}

export async function topMerchants(conn: Conn, start: string, end: string): Promise<Row[]> {
  return (await conn.execute(`
    SELECT merchant, MAX(category) AS category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
    WHERE date >= ? AND date < ? AND merchant != '' AND ${SPEND_SQL}
    GROUP BY merchant HAVING -SUM(amount) > 0 ORDER BY amount DESC LIMIT 8
  `, [start, end, ...SPEND_ARGS])).rows;
}

export async function income(conn: Conn, start: string, end: string): Promise<number> {
  return first((await conn.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = 'income' AND currency = 'EUR'",
    [start, end])).one());
}

export async function spendingCount(conn: Conn, start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT COUNT(*) FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} AND amount < 0`,
    [start, end, ...SPEND_ARGS])).one());
}

export async function oldestDay(conn: Conn): Promise<string | null> {
  return first((await conn.execute("SELECT MIN(date) FROM transactions")).one());
}

/** Filters for the transaction list; service is applied as the ids it covers. */
export interface ListFilter {
  start?: string; end?: string; category?: string; account?: string; commitment?: number | null; search?: string; ids?: string[];
}

function where(f: ListFilter): [string, unknown[]] {
  // Debit-card copies are hidden; the current-account row (with the merchant name) stands for both.
  const w = ["duplicate_of IS NULL", "status != 'OFFSET'"];
  const args: unknown[] = [];
  if (f.start != null) { w.push("date >= ? AND date < ?"); args.push(f.start, f.end); }
  if (f.category) { w.push("category = ?"); args.push(f.category); }
  if (f.account) { w.push("account = ?"); args.push(f.account); }
  if (f.commitment != null) { w.push("commitment_id = ?"); args.push(f.commitment); }
  if (f.search) { w.push("(merchant ILIKE ? OR description ILIKE ?)"); args.push(`%${f.search}%`, `%${f.search}%`); }
  if (f.ids) { w.push(f.ids.length ? `t.id IN (${f.ids.map(() => "?").join(",")})` : "false"); args.push(...f.ids); }
  return [`WHERE ${w.join(" AND ")}`, args];
}

/** A page of the list, newest first, with the total count and the spending across every page. */
export async function list(conn: Conn, f: ListFilter, limit: number, offset: number): Promise<{ rows: Row[]; total: number; spent: number }> {
  const [sqlWhere, args] = where(f);
  const rows = (await conn.execute(`
    SELECT t.id, t.date, t.amount, t.currency, t.status, t.description, t.merchant, t.mcc, t.category,
      t.commitment_id, a.name AS account_name, a.is_card
    FROM transactions t JOIN accounts a ON a.id = t.account ${sqlWhere}
    ORDER BY t.date DESC, t.id LIMIT ? OFFSET ?
  `, [...args, limit, offset])).rows;
  const total = first((await conn.execute(`SELECT COUNT(*) FROM transactions t ${sqlWhere}`, args)).one());
  const spent = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions t ${sqlWhere} AND amount < 0`, args)).one());
  return { rows, total, spent };
}

/** The payee of one payment: undefined when there's no such payment. */
export async function merchantOf(conn: Conn, id: string): Promise<{ merchant: string } | undefined> {
  return (await conn.execute<{ merchant: string }>("SELECT merchant FROM transactions WHERE id = ?", [id])).one();
}

export async function merchantsOf(conn: Conn, ids: string[]): Promise<{ id: string; merchant: string }[]> {
  if (!ids.length) return [];
  return (await conn.execute<{ id: string; merchant: string }>(`SELECT id, merchant FROM transactions WHERE id IN (${ids.map(() => "?").join(",")})`, ids)).rows;
}

/** Other payments to a payee still in a different category and without a rule of their own. */
export async function othersElsewhere(conn: Conn, merchant: string, exceptId: string, category: string): Promise<number> {
  return first((await conn.execute(`
    SELECT COUNT(*) FROM transactions WHERE merchant = ? AND id != ? AND category != ?
      AND duplicate_of IS NULL AND status != 'OFFSET'
      AND 'tx:' || id NOT IN (SELECT merchant FROM rules)
  `, [merchant, exceptId, category])).one());
}

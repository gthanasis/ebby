/** The transactions table, read on its own or with each payment's account. Spending sums use SPEND_SQL, so they
 * count what the rest of the app counts as spending. */

import { first, type Conn, type Row } from "../db.js";
import { COMMITTED_SQL, SPEND_ARGS, SPEND_SQL } from "../spend_sql.js";

// SPEND_SQL for queries that join accounts.
let T = SPEND_SQL;
for (const col of ["duplicate_of", "commitment_id", "currency", "category IN"]) T = T.replace(col, `t.${col}`);

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
      t.commitment_id, a.name AS account_name, a.is_card, NULLIF(t.raw::json->>'booking_date', t.date) AS booked
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

/** Spending from first up to and including last, as a positive sum. */
export async function spentThrough(conn: Conn, firstDay: string, lastDay: string): Promise<number> {
  return first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date <= ? AND ${SPEND_SQL}`,
    [firstDay, lastDay, ...SPEND_ARGS])).one());
}

/** Spending per day in [start, end), unordered. */
export async function spentPerDay(conn: Conn, start: string, end: string): Promise<{ date: string; spent: number }[]> {
  return (await conn.execute<{ date: string; spent: number }>(
    `SELECT date, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY date`,
    [start, end, ...SPEND_ARGS])).rows;
}

/** Spending per day from first up to and including last, unordered. */
export async function spentPerDayThrough(conn: Conn, firstDay: string, lastDay: string): Promise<{ date: string; spent: number }[]> {
  return (await conn.execute<{ date: string; spent: number }>(
    `SELECT date, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date <= ? AND ${SPEND_SQL} GROUP BY date`,
    [firstDay, lastDay, ...SPEND_ARGS])).rows;
}

export async function spentPerCategory(conn: Conn, start: string, end: string): Promise<{ category: string; spent: number }[]> {
  return (await conn.execute<{ category: string; spent: number }>(`
    SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
}

/** Spending and payment count per category in [start, end), unordered. */
export async function spentAndCountByCategory(conn: Conn, start: string, end: string): Promise<{ category: string; spent: number; count: number }[]> {
  return (await conn.execute<{ category: string; spent: number; count: number }>(`
    SELECT category, -SUM(amount) AS spent, COUNT(*) FILTER (WHERE amount < 0) AS count FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
}

/** Categories with spending in [start, end), biggest first, with every row counted. */
export async function categoriesBySpent(conn: Conn, start: string, end: string): Promise<{ category: string; spent: number; count: number }[]> {
  return (await conn.execute<{ category: string; spent: number; count: number }>(`
    SELECT category, -SUM(amount) AS spent, COUNT(*) AS count FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY spent DESC
  `, [start, end, ...SPEND_ARGS])).rows;
}

export async function topCategory(conn: Conn, start: string, end: string): Promise<{ category: string; spent: number } | undefined> {
  return (await conn.execute<{ category: string; spent: number }>(`
      SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL}
      GROUP BY category ORDER BY spent DESC LIMIT 1
    `, [start, end, ...SPEND_ARGS])).one();
}

/** Per category over three months in [start, end): spending a month, payments a month, and the average payment. */
export async function threeMonthHabits(conn: Conn, start: string, end: string): Promise<{ category: string; monthly: number; per_month: number; avg: number }[]> {
  return (await conn.execute<{ category: string; monthly: number; per_month: number; avg: number }>(`
    SELECT category, -SUM(amount) / 3.0 AS monthly, COUNT(*) FILTER (WHERE amount < 0) / 3.0 AS per_month,
           -SUM(amount) / GREATEST(1, COUNT(*) FILTER (WHERE amount < 0)) AS avg FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
}

/** Committed spending in [start, end), as a positive sum. */
export async function committed(conn: Conn, start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND ${COMMITTED_SQL}`,
    [start, end])).one());
}

/** One commitment's spending in [start, end), as a positive sum. */
export async function committedTo(conn: Conn, commitmentId: number, start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND ${COMMITTED_SQL}`,
    [commitmentId, start, end])).one());
}

/** One commitment's payments in [start, end). */
export async function committedCount(conn: Conn, commitmentId: number, start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT COUNT(*) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND amount < 0 AND ${COMMITTED_SQL}`,
    [commitmentId, start, end])).one());
}

/** The years with any payments, oldest first. */
export async function years(conn: Conn): Promise<string[]> {
  return (await conn.execute("SELECT DISTINCT substr(date, 1, 4) FROM transactions ORDER BY 1")).rows.map(first);
}

/** A category's free spending in [start, end), committed rows left out, as a positive sum. */
export async function categorySpent(conn: Conn, start: string, end: string, category: string): Promise<number> {
  return first((await conn.execute("SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = ? AND currency = 'EUR' AND duplicate_of IS NULL AND commitment_id IS NULL",
    [start, end, category])).one());
}

/** A payment's payee fields, as serviceName reads them. */
export type PayeeFields = { merchant: string; description: string; mcc: string | null; is_card: number };

export async function categoryPayments(conn: Conn, start: string, end: string, category: string): Promise<(PayeeFields & { amount: number; account: string })[]> {
  return (await conn.execute<PayeeFields & { amount: number; account: string }>(`
    SELECT t.amount, t.merchant, t.description, t.mcc, a.name AS account, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.date < ? AND t.category = ? AND t.currency = 'EUR'
      AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
  `, [start, end, category])).rows;
}

/** A category's free payments, between two days when given, for picking out one service's. */
export async function servicePayments(conn: Conn, category: string, start?: string | null, end?: string | null): Promise<(PayeeFields & { id: string; date: string; amount: number })[]> {
  const where = ["t.category = ?", "t.currency = 'EUR'", "t.duplicate_of IS NULL", "t.commitment_id IS NULL"];
  const args: unknown[] = [category];
  if (start) { where.push("t.date >= ?"); args.push(start); }
  if (end) { where.push("t.date < ?"); args.push(end); }
  return (await conn.execute<PayeeFields & { id: string; date: string; amount: number }>(`
    SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE ${where.join(" AND ")}
  `, args)).rows;
}

/** Every payment but cash offsets, with its payee fields. */
export async function payees(conn: Conn): Promise<(PayeeFields & { id: string })[]> {
  return (await conn.execute<PayeeFields & { id: string }>(`SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                    JOIN accounts a ON a.id = t.account WHERE t.status != 'OFFSET'`)).rows;
}

/** Every non-zero payment with its payee fields, for tagging commitments. */
export async function nonZeroPayees(conn: Conn): Promise<(PayeeFields & { id: string })[]> {
  return (await conn.execute<PayeeFields & { id: string }>(`SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                       JOIN accounts a ON a.id = t.account WHERE t.amount < 0 OR t.amount > 0`)).rows;
}

export async function clearCommitments(conn: Conn) {
  await conn.execute("UPDATE transactions SET commitment_id = NULL WHERE commitment_id IS NOT NULL");
}

export async function setCommitment(conn: Conn, id: string, commitmentId: number) {
  await conn.execute("UPDATE transactions SET commitment_id = ? WHERE id = ?", [commitmentId, id]);
}

/** Euro payments out since a day, transfers, card payments and income left out unless transfers (big ones only). */
export async function outgoingSince(conn: Conn, since: string, transfers: boolean): Promise<(PayeeFields & { date: string; amount: number; category: string })[]> {
  return (await conn.execute<PayeeFields & { date: string; amount: number; category: string }>(`SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.amount < 0 AND t.duplicate_of IS NULL AND t.currency = 'EUR'
      AND (t.category NOT IN ('transfer', 'card_payment', 'income') OR (?::boolean AND t.category = 'transfer' AND t.amount <= -300))`,
    [since, transfers])).rows;
}

/** Euro payments out since a day in the categories subscriptions show up in. */
export async function subscriptionCandidates(conn: Conn, since: string): Promise<(PayeeFields & { date: string; amount: number; category: string })[]> {
  return (await conn.execute<PayeeFields & { date: string; amount: number; category: string }>(`
    SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account
    WHERE t.date >= ? AND t.currency = 'EUR' AND t.amount < 0 AND t.duplicate_of IS NULL
      AND t.category IN ('subscriptions', 'bills', 'health', 'leisure', 'insurance', 'loans', 'education')
  `, [since])).rows;
}

/** Payments out left in Other since a day, biggest first. */
export async function leftInOther(conn: Conn, since: string): Promise<(PayeeFields & { id: string; date: string; amount: number; account: string })[]> {
  return (await conn.execute<PayeeFields & { id: string; date: string; amount: number; account: string }>(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card, a.name AS account
    FROM transactions t JOIN accounts a ON a.id = t.account
    WHERE t.category = 'other' AND t.amount < 0 AND t.date >= ? AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
      AND t.status != 'OFFSET' ORDER BY t.amount`, [since])).rows;
}

/** Free spending between two days (both included), oldest first, with payee fields. */
export async function spendRows(conn: Conn, firstDay: string, lastDay: string): Promise<(PayeeFields & { date: string; amount: number; category: string })[]> {
  return (await conn.execute<PayeeFields & { date: string; amount: number; category: string }>(`SELECT t.date, -t.amount AS amount, t.category, t.merchant, t.description, t.mcc, a.is_card
      FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.date <= ? AND ${T}
      ORDER BY t.date, t.amount`, [firstDay, lastDay, ...SPEND_ARGS])).rows;
}

/** Euro income deposits of at least min since a day, oldest first. */
export async function payDeposits(conn: Conn, min: number, since: string): Promise<{ date: string; amount: number }[]> {
  return (await conn.execute<{ date: string; amount: number }>(`SELECT date, amount FROM transactions WHERE category = 'income' AND amount >= ? AND currency = 'EUR'
                                      AND duplicate_of IS NULL AND date >= ? ORDER BY date`, [min, since])).rows;
}

/** The latest euro income deposit of at least min. */
export async function lastPay(conn: Conn, min: number): Promise<{ date: string; amount: number } | undefined> {
  return (await conn.execute<{ date: string; amount: number }>(`SELECT date, amount FROM transactions WHERE category = 'income' AND amount >= ? AND currency = 'EUR'
                                 AND duplicate_of IS NULL ORDER BY date DESC LIMIT 1`, [min])).one();
}

/** Net euro movement in some accounts since a day. */
export async function netInto(conn: Conn, accounts: string[], since: string): Promise<number> {
  return first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN (${accounts.map(() => "?").join(",")})
                                        AND date >= ? AND duplicate_of IS NULL AND currency = 'EUR'`, [...accounts, since])).one());
}

/** Euros paid into some accounts in [start, end), money taken out not counted. */
export async function paidInto(conn: Conn, accounts: string[], start: string, end: string): Promise<number> {
  return first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN (${accounts.map(() => "?").join(",")})
                                   AND amount > 0 AND date >= ? AND date < ? AND duplicate_of IS NULL AND currency = 'EUR'`,
    [...accounts, start, end])).one());
}

/** Insurance and annual-fee charges over €30 since a day. */
export async function yearlyCharges(conn: Conn, since: string): Promise<{ date: string; amount: number; description: string; merchant: string }[]> {
  return (await conn.execute<{ date: string; amount: number; description: string; merchant: string }>(`SELECT date, amount, description, merchant FROM transactions
    WHERE date >= ? AND amount < -30 AND duplicate_of IS NULL AND currency = 'EUR' AND status != 'OFFSET'
      AND (description LIKE '%ΑΣΦΑΛ%' OR description LIKE '%ΑSFΑL%' OR description LIKE '%ΕΤΗΣΙΑ%' OR description LIKE '%INTERAMERICAN%'
           OR description LIKE '%ΙΝΤΕRΑΜΕRΙCΑΝ%' OR mcc LIKE '63%')`, [since])).rows;
}

/** Cash withdrawn from bank accounts (not the hand-kept cash account) in [start, end), as a negative sum. */
export async function cashWithdrawn(conn: Conn, start: string, end: string, cashAccount: string): Promise<number> {
  return first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND category = 'cash' AND account != ? AND amount < 0 AND duplicate_of IS NULL AND currency = 'EUR'`, [start, end, cashAccount])).one());
}

/** Cash spending logged by hand in [start, end), as a negative sum. */
export async function cashLogged(conn: Conn, start: string, end: string, cashAccount: string): Promise<number> {
  return first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND account = ? AND status = 'CASH' AND amount < 0`, [start, end, cashAccount])).one());
}

/** A cash payment logged by hand; merchant and description are the same text. */
export async function addCash(conn: Conn, id: string, account: string, day: string, amount: number, text: string, category: string, raw: string) {
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
                      VALUES(?, ?, ?, ?, 'EUR', 'CASH', ?, ?, NULL, ?, ?)`,
    [id, account, day, amount, text, text, category, raw]);
}

/** The credit in Cash that balances a logged cash payment; it never shows in lists (status OFFSET). */
export async function addCashOffset(conn: Conn, id: string, account: string, day: string, amount: number, description: string, raw: string) {
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw, duplicate_of)
                      VALUES(?, ?, ?, ?, 'EUR', 'OFFSET', ?, '', NULL, 'cash', ?, NULL)`,
    [id, account, day, amount, description, raw]);
}

/** Payments since a day with their account, oldest first, debit-card copies left out: what Claude reads. */
export async function forContext(conn: Conn, since: string): Promise<(PayeeFields & { date: string; amount: number; currency: string; category: string; commitment_id: number | null; account: string })[]> {
  return (await conn.execute<PayeeFields & { date: string; amount: number; currency: string; category: string; commitment_id: number | null; account: string }>(`
    SELECT t.date, t.amount, t.currency, t.category, t.merchant, t.description, t.mcc, t.commitment_id, a.name AS account, a.is_card
    FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.duplicate_of IS NULL ORDER BY t.date
  `, [since])).rows;
}

/** One payment with its account's name, bank and kind. */
export async function withAccount(conn: Conn, id: string): Promise<(PayeeFields & { id: string; date: string; amount: number; account_name: string; bank: string | null }) | undefined> {
  return (await conn.execute<PayeeFields & { id: string; date: string; amount: number; account_name: string; bank: string | null }>(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.name AS account_name, a.bank, a.is_card
                                   FROM transactions t JOIN accounts a ON a.id = t.account WHERE t.id = ?`, [id])).one();
}

/** The six latest other payments out with the same merchant or bank text, newest first. */
export async function earlierToPayee(conn: Conn, merchant: string, description: string, exceptId: string): Promise<{ date: string; amount: number }[]> {
  return (await conn.execute<{ date: string; amount: number }>(`SELECT date, amount FROM transactions WHERE (merchant = ? OR description = ?) AND amount < 0 AND duplicate_of IS NULL
                                         AND id != ? ORDER BY date DESC, id DESC LIMIT 6`, [merchant, description, exceptId])).rows;
}

/** Filters for the assistant's search: a pay month's bounds, or from/to days (both included). */
export interface SearchFilter { start?: string; end?: string; from?: string; to?: string; category?: string; amount?: number }

/** Payments the filters allow, newest first; amount matches within 10% (at least €1). */
export async function search(conn: Conn, f: SearchFilter): Promise<(PayeeFields & { id: string; date: string; amount: number; category: string })[]> {
  const where = ["t.duplicate_of IS NULL", "t.status != 'OFFSET'"];
  const params: unknown[] = [];
  if (f.start != null) {
    where.push("t.date >= ? AND t.date < ?"); params.push(f.start, f.end);
  } else {
    if (f.from) { where.push("t.date >= ?"); params.push(f.from); }
    if (f.to) { where.push("t.date <= ?"); params.push(f.to); }
  }
  if (f.category) { where.push("t.category = ?"); params.push(f.category); }
  if (f.amount) { where.push("ABS(ABS(t.amount) - ?) <= ?"); params.push(Math.abs(f.amount), Math.max(1.0, Math.abs(f.amount) * 0.1)); }
  return (await conn.execute<PayeeFields & { id: string; date: string; amount: number; category: string }>(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card
    FROM transactions t JOIN accounts a ON a.id = t.account WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.id`, params)).rows;
}

export async function allIds(conn: Conn): Promise<string[]> {
  return (await conn.execute<{ id: string }>("SELECT id FROM transactions")).rows.map((x) => x.id);
}

export async function dateAndAmount(conn: Conn, id: string): Promise<{ date: string; amount: number } | undefined> {
  return (await conn.execute<{ date: string; amount: number }>("SELECT date, amount FROM transactions WHERE id = ?", [id])).one();
}

/** One payment's day, amount and payee fields. */
export async function payeeOf(conn: Conn, id: string): Promise<(PayeeFields & { date: string; amount: number }) | undefined> {
  return (await conn.execute<PayeeFields & { date: string; amount: number }>(`SELECT t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                 JOIN accounts a ON a.id = t.account WHERE t.id = ?`, [id])).one();
}

// ---------- storing what the bank sent ----------

/** Pending rows get new ids once booked, so a fetched window replaces the ones it covers. */
export async function deletePending(conn: Conn, account: string, start: string, end: string) {
  await conn.execute("DELETE FROM transactions WHERE account = ? AND status = 'PDNG' AND date BETWEEN ? AND ?", [account, start, end]);
}

/** Stores a bank row [id, account, date, amount, currency, status, description, merchant, mcc, category, raw]; a row
 * already stored keeps its merchant and category, and its date while a card row is paired with it. Returns rows changed. */
export async function upsertBankRow(conn: Conn, row: unknown[]): Promise<number> {
  return (await conn.execute(`
    INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET amount = excluded.amount, status = excluded.status,
      date = CASE WHEN EXISTS (SELECT 1 FROM transactions c WHERE c.duplicate_of = transactions.id
                               AND c.user_id = transactions.user_id) THEN transactions.date ELSE excluded.date END,
      raw = excluded.raw
  `, row)).rowCount;
}

export async function allRaw(conn: Conn): Promise<{ id: string; account: string; raw: string; mcc: string | null }[]> {
  return (await conn.execute<{ id: string; account: string; raw: string; mcc: string | null }>("SELECT id, account, raw, mcc FROM transactions")).rows;
}

export async function setMerchantAndCategory(conn: Conn, id: string, merchant: string, category: string) {
  await conn.execute("UPDATE transactions SET merchant = ?, category = ? WHERE id = ?", [merchant, category, id]);
}

// ---------- pairing debit-card rows with their account copies ----------

export async function clearOrphanDuplicates(conn: Conn) {
  await conn.execute(`UPDATE transactions SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL
                      AND duplicate_of NOT IN (SELECT id FROM transactions)`);
}

export async function cardPurchases(conn: Conn, account: string): Promise<{ id: string; date: string; amount: number; mcc: string | null }[]> {
  return (await conn.execute<{ id: string; date: string; amount: number; mcc: string | null }>(
    "SELECT id, date, amount, mcc FROM transactions WHERE account = ? AND amount < 0 ORDER BY date", [account])).rows;
}

/** Account rows already paired with a card row. */
export async function paired(conn: Conn): Promise<Set<string>> {
  return new Set((await conn.execute<{ duplicate_of: string }>("SELECT duplicate_of FROM transactions WHERE duplicate_of IS NOT NULL")).rows.map((r) => r.duplicate_of));
}

/** Account rows at the same bank for the same amount, from a day before to six days after, nearest first. */
export async function accountCopies(conn: Conn, bank: string, amount: number, date: string): Promise<{ id: string }[]> {
  return (await conn.execute<{ id: string }>(`
    SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account
    WHERE a.is_card = 0 AND a.bank = ? AND t.amount = ? AND t.category NOT IN ('transfer', 'investments', 'card_payment', 'income')
      AND t.date::date - ?::date BETWEEN -1 AND 6
    ORDER BY abs(t.date::date - ?::date)
  `, [bank, amount, date, date])).rows;
}

/** Marks a card row as the copy of an account row; 1 if it wasn't already paired. */
export async function markDuplicate(conn: Conn, cardRow: string, accountRow: string): Promise<number> {
  return (await conn.execute("UPDATE transactions SET duplicate_of = ? WHERE id = ? AND duplicate_of IS NULL", [accountRow, cardRow])).rowCount;
}

export async function fillMcc(conn: Conn, id: string, mcc: string) {
  await conn.execute("UPDATE transactions SET mcc = ? WHERE id = ? AND (mcc IS NULL OR mcc = '')", [mcc, id]);
}

/** Paired account rows take the card row's date: the day you paid. */
export async function datePairsByCard(conn: Conn) {
  await conn.execute(`UPDATE transactions t SET date = c.date FROM transactions c
                      WHERE c.duplicate_of = t.id AND c.user_id = t.user_id AND t.date <> c.date`);
}

/** Categories, the month's overview, the transaction list, and moving a payment to another category. */

import type { Hono } from "hono";
import { z } from "zod";

import * as db from "../data/db.js";
import { type Conn, first, type Row } from "../data/db.js";
import { CATEGORIES } from "../domain/categories.js";
import * as insights from "../domain/insights.js";
import { PyDate, pyRound, sorted } from "../py.js";
import { body, fail, int } from "./http.js";

// Totals only add up euros; rows in other currencies (Revolut pockets) still show in the list.
const { SPEND_SQL, SPEND_ARGS } = insights;

/** [YYYY-MM, first day, first day of the next month] of a pay month. */
function month(m: string | null | undefined): [string, string, string] {
  const key = m || insights.thisMonth();
  return [key, ...insights.monthBounds(key)];
}

async function spent(conn: Conn, start: string, end: string): Promise<number> {
  return pyRound(first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL}`,
    [start, end, ...SPEND_ARGS])).one()), 2);
}

export function routes(app: Hono) {
  app.get("/api/categories", (c) =>
    c.json(Object.entries(CATEGORIES).map(([id, [label, icon, spending]]) => ({ id, label, icon, spending }))));

  app.get("/api/overview", async (c) => {
    const [key, start, end] = month(c.req.query("month"));
    const today = insights.localToday().isoformat();
    return c.json(await db.connect(async (conn) => {
      const total = await spent(conn, start, end);
      const [prevKey, prevStart, prevEnd] = month(insights.shift(key, -1));
      const prevTotal = await spent(conn, prevStart, prevEnd);
      // Same point last month, so a half-finished month compares fairly.
      const current = start <= today && today < end;
      const elapsed = PyDate.fromisoformat(today).diffDays(PyDate.fromisoformat(start)) + 1;
      const prevToDate = current ? await spent(conn, prevStart, PyDate.fromisoformat(prevStart).addDays(elapsed).isoformat()) : prevTotal;
      const byCategory = (await conn.execute(`
        SELECT category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
        WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY amount DESC
      `, [start, end, ...SPEND_ARGS])).rows;
      const daily = (await conn.execute(`
        SELECT date, -SUM(amount) AS amount FROM transactions
        WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY date ORDER BY date
      `, [start, end, ...SPEND_ARGS])).rows;
      const firstMonth = month(insights.shift(key, -11))[1];
      const byMonth = new Map<string, { spent: number; income: number }>();
      for (const r of await conn.execute(`
        SELECT date,
          -SUM(CASE WHEN ${SPEND_SQL} THEN amount ELSE 0 END) AS spent,
          SUM(CASE WHEN category = 'income' AND currency = 'EUR' THEN amount ELSE 0 END) AS income
        FROM transactions WHERE date >= ? AND date < ? GROUP BY date
      `, [...SPEND_ARGS, firstMonth, end])) {
        const k = insights.monthOf(r.date);
        const m = byMonth.get(k) ?? { spent: 0.0, income: 0.0 };
        m.spent += r.spent; m.income += r.income;
        byMonth.set(k, m);
      }
      const monthly = sorted(byMonth.entries(), ([k]) => k).map(([k, v]) => ({ month: k, spent: pyRound(v.spent, 2), income: pyRound(v.income, 2) }));
      const merchants = (await conn.execute(`
        SELECT merchant, MAX(category) AS category, -SUM(amount) AS amount, COUNT(*) AS count FROM transactions
        WHERE date >= ? AND date < ? AND merchant != '' AND ${SPEND_SQL}
        GROUP BY merchant HAVING -SUM(amount) > 0 ORDER BY amount DESC LIMIT 8
      `, [start, end, ...SPEND_ARGS])).rows;
      const income = first((await conn.execute("SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = 'income' AND currency = 'EUR'",
        [start, end])).one());
      const count = first((await conn.execute(`SELECT COUNT(*) FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} AND amount < 0`,
        [start, end, ...SPEND_ARGS])).one());
      const oldestDay = first((await conn.execute("SELECT MIN(date) FROM transactions")).one());
      return {
        month: key, start, end, current, total, count, income: pyRound(income, 2),
        prev_month: prevKey, prev_total: prevTotal, prev_to_date: prevToDate,
        by_category: byCategory, daily, monthly, merchants, oldest_month: oldestDay ? insights.monthOf(oldestDay) : null,
      };
    }));
  });

  app.get("/api/transactions", async (c) => {
    const q = (n: string) => c.req.query(n);
    const category = q("category"), account = q("account"), search = q("q"), service = q("service");
    const commitment = int(q("commitment"), "commitment", null);
    const limit = int(q("limit"), "limit", 200), offset = int(q("offset"), "offset", 0);
    // Debit-card copies are hidden; the current-account row (with the merchant name) stands for both.
    const where = ["duplicate_of IS NULL", "status != 'OFFSET'"];
    const args: unknown[] = [];
    if (q("month")) { const [, start, end] = month(q("month")); where.push("date >= ? AND date < ?"); args.push(start, end); }
    if (category) { where.push("category = ?"); args.push(category); }
    if (account) { where.push("account = ?"); args.push(account); }
    if (commitment != null) { where.push("commitment_id = ?"); args.push(commitment); }
    if (search) { where.push("(merchant ILIKE ? OR description ILIKE ?)"); args.push(`%${search}%`, `%${search}%`); }
    if (service && category) {
      // Services are named in code (insights.serviceName), so filter to their ids first.
      const ids = await db.connect((conn) => insights.serviceTransactionIds(conn, category, service));
      where.push(ids.length ? `t.id IN (${ids.map(() => "?").join(",")})` : "false");
      args.push(...ids);
    }
    const sqlWhere = `WHERE ${where.join(" AND ")}`;
    return c.json(await db.connect(async (conn) => {
      const rows = (await conn.execute(`
        SELECT t.id, t.date, t.amount, t.currency, t.status, t.description, t.merchant, t.mcc, t.category,
          t.commitment_id, a.name AS account_name, a.is_card
        FROM transactions t JOIN accounts a ON a.id = t.account ${sqlWhere}
        ORDER BY t.date DESC, t.id LIMIT ? OFFSET ?
      `, [...args, Math.min(limit, 500), offset])).rows;
      const total = first((await conn.execute(`SELECT COUNT(*) FROM transactions t ${sqlWhere}`, args)).one());
      const spentSum = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions t ${sqlWhere} AND amount < 0`, args)).one());
      return { rows, total, spent: pyRound(spentSum, 2) };
    }));
  });

  /** Moves one payment, or with all_from_merchant every payment to its payee (now and in future). Payments given their
   * own category stay as they are either way. Returns how many other payments to the payee are still in a different
   * category, so the app can offer to move those too. */
  app.put("/api/transactions/:txId{.+}/category", async (c) => {
    const txId = c.req.param("txId");
    const b = await body(c, z.object({ category: z.string(), all_from_merchant: z.boolean().default(false) }));
    if (!(b.category in CATEGORIES)) fail(400, "Unknown category");
    return c.json(await db.connect(async (conn) => {
      const row: Row | undefined = (await conn.execute("SELECT merchant FROM transactions WHERE id = ?", [txId])).one();
      if (!row) fail(404, "No such transaction");
      const merchant = row!.merchant;
      const key = b.all_from_merchant && merchant ? merchant : `tx:${txId}`;
      await conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
        [key, b.category]);
      if (key === merchant) {
        // Payments whose own rule now matches the payee's follow the payee again.
        await conn.execute(`DELETE FROM rules WHERE category = ? AND merchant IN (
                              SELECT 'tx:' || id FROM transactions WHERE merchant = ?)`, [b.category, merchant]);
      }
      await db.recategorize(conn);
      const others = merchant ? first((await conn.execute(`
        SELECT COUNT(*) FROM transactions WHERE merchant = ? AND id != ? AND category != ?
          AND duplicate_of IS NULL AND status != 'OFFSET'
          AND 'tx:' || id NOT IN (SELECT merchant FROM rules)
      `, [merchant, txId, b.category])).one()) : 0;
      return { ok: true, rule: key, merchant: merchant || null, others };
    }));
  });
}

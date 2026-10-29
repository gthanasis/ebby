/** Categories, the month's overview, the transaction list, and moving a payment to another category. */

import type { Hono } from "hono";
import { z } from "zod";

import * as db from "../../shared/db.js";
import * as rulesRepo from "../../shared/ledger/rules.js";
import * as tx from "../../shared/ledger/transactions.js";
import { CATEGORIES } from "../../shared/categories.js";
import { localToday, monthBounds, monthOf, shift, thisMonth } from "../../shared/months.js";
import { serviceTransactionIds } from "../spending/services.js";
import { PyDate, pyRound } from "../../shared/utils/python.js";
import { body, fail, int } from "../../shared/http.js";
import * as ingest from "../banks/ingest.js";
import { payment, pin } from "./service.js";
import { toCategories, toCategoryMove, toMonthly, toOverview, toPayeeName, toTransactionPage } from "./converters.js";

// Totals only add up euros; rows in other currencies (Revolut pockets) still show in the list.

/** [YYYY-MM, first day, first day of the next month] of a pay month. */
function month(m: string | null | undefined): [string, string, string] {
  const key = m || thisMonth();
  return [key, ...monthBounds(key)];
}

const spent = async (conn: db.Conn, start: string, end: string) => pyRound(await tx.spent(conn, start, end), 2);

export function routes(app: Hono) {
  app.get("/api/categories", (c) => c.json(toCategories(CATEGORIES)));

  app.get("/api/overview", async (c) => {
    const [key, start, end] = month(c.req.query("month"));
    const today = localToday().isoformat();
    return c.json(await db.connect(async (conn) => {
      const total = await spent(conn, start, end);
      const [prevKey, prevStart, prevEnd] = month(shift(key, -1));
      const prevTotal = await spent(conn, prevStart, prevEnd);
      // Same point last month, so a half-finished month compares fairly.
      const current = start <= today && today < end;
      const elapsed = PyDate.fromisoformat(today).diffDays(PyDate.fromisoformat(start)) + 1;
      const prevToDate = current ? await spent(conn, prevStart, PyDate.fromisoformat(prevStart).addDays(elapsed).isoformat()) : prevTotal;
      const byCategory = await tx.spentByCategory(conn, start, end);
      const daily = await tx.spentByDay(conn, start, end);
      const firstMonth = month(shift(key, -11))[1];
      const byMonth = new Map<string, { spent: number; income: number }>();
      for (const r of await tx.spentAndIncomeByDay(conn, firstMonth, end)) {
        const k = monthOf(r.date);
        const m = byMonth.get(k) ?? { spent: 0.0, income: 0.0 };
        m.spent += r.spent; m.income += r.income;
        byMonth.set(k, m);
      }
      const monthly = toMonthly(byMonth);
      const merchants = await tx.topMerchants(conn, start, end);
      const income = await tx.income(conn, start, end);
      const count = await tx.spendingCount(conn, start, end);
      const oldestDay = await tx.oldestDay(conn);
      return toOverview({
        month: key, start, end, current, total, count, income,
        prev_month: prevKey, prev_total: prevTotal, prev_to_date: prevToDate,
        by_category: byCategory, daily, monthly, merchants, oldest_month: oldestDay ? monthOf(oldestDay) : null,
      });
    }));
  });

  app.get("/api/transactions", async (c) => {
    const q = (n: string) => c.req.query(n);
    const category = q("category"), account = q("account"), search = q("q"), service = q("service");
    const commitment = int(q("commitment"), "commitment", null);
    const limit = int(q("limit"), "limit", 200), offset = int(q("offset"), "offset", 0);
    const filter: tx.ListFilter = { category, account, commitment, search };
    if (q("month")) [, filter.start, filter.end] = month(q("month"));
    // Services are named in code (serviceName), so filter to their ids first.
    if (service && category) filter.ids = await db.connect((conn) => serviceTransactionIds(conn, category, service));
    return c.json(await db.connect(async (conn) => {
      const { rows, total, spent: spentSum } = await tx.list(conn, filter, Math.min(limit, 500), offset);
      return toTransactionPage(rows, total, spentSum);
    }));
  });

  /** One payment, by id in the query: ids can hold any character. */
  app.get("/api/payment", async (c) => {
    const id = c.req.query("id") || fail(400, "Which payment?");
    return c.json(await db.connect((conn) => payment(conn, id)));
  });

  app.put("/api/payment/commitment", async (c) => {
    const b = await body(c, z.object({ id: z.string(), commitment_id: z.number().int().nullable() }));
    return c.json(await db.connect((conn) => pin(conn, b.id, b.commitment_id)));
  });

  /** Moves one payment, or with all_from_merchant every payment to its payee (now and in future). Payments given their
   * own category stay as they are either way. Returns how many other payments to the payee are still in a different
   * category, so the app can offer to move those too. */
  app.put("/api/transactions/:txId{.+}/category", async (c) => {
    const txId = c.req.param("txId");
    const b = await body(c, z.object({ category: z.string(), all_from_merchant: z.boolean().default(false) }));
    if (!(b.category in CATEGORIES)) fail(400, "Unknown category");
    return c.json(await db.connect(async (conn) => {
      const row = await tx.merchantOf(conn, txId);
      if (!row) fail(404, "No such transaction");
      const merchant = row!.merchant;
      const key = b.all_from_merchant && merchant ? merchant : `tx:${txId}`;
      await rulesRepo.set(conn, key, b.category);
      if (key === merchant) {
        // Payments whose own rule now matches the payee's follow the payee again.
        await rulesRepo.dropPaymentRulesMatching(conn, merchant, b.category);
      }
      await ingest.recategorize(conn);
      const others = merchant ? await tx.othersElsewhere(conn, merchant, txId, b.category) : 0;
      return toCategoryMove(key, merchant, others);
    }));
  });

  /** Gives a payment's payee your own name, such as who an IRIS payment to a phone number went to: every payment to it,
   * past and future, shows the name. An empty name gives it back the bank's. */
  app.put("/api/transactions/:txId{.+}/payee", async (c) => {
    const txId = c.req.param("txId");
    const b = await body(c, z.object({ name: z.string().max(60) }));
    return c.json(await db.connect(async (conn) => {
      const named = await ingest.namePayee(conn, txId, b.name.trim().replace(/\s+/g, " "));
      if (!named) return fail(404, "No such transaction");
      if (!named.payee) return fail(400, "The bank didn't say who this payment went to, so there's no payee to name.");
      return toPayeeName(named.payee, named.merchant, named.payments);
    }));
  });
}

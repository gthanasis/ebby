/** Where the money went: home, spending by period, pace, categories, services, subscriptions, the year. */

import type { Hono } from "hono";
import { z } from "zod";

import * as clock from "../../shared/clock.js";
import * as db from "../../shared/db.js";
import * as rulesRepo from "../../shared/ledger/rules.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import * as ai from "../assistant/ai.js";
import * as aiUsage from "../assistant/ai_usage.js";
import { CATEGORIES } from "../../shared/categories.js";
import * as spending from "./service.js";
import * as accountSettings from "../account/settings.js";
import { body, fail, int, integer, required } from "../../shared/http.js";
import { serviceDetail, serviceTransactionIds } from "./services.js";
import { categoryDetail } from "../plan/category.js";
import { thisMonth } from "../../shared/months.js";
import { detectPayday } from "../plan/payday.js";
import { pace } from "../plan/pace.js";
import { subscriptions } from "./subscriptions.js";
import { todayView } from "../plan/today.js";
import { year } from "../plan/year.js";
import * as ingest from "../banks/ingest.js";

const RANGE_ERROR = "range is day, week, month or year; off is 0 or less";

export function routes(app: Hono) {
  app.get("/api/home", async (c) => c.json(await db.connect(async (conn) => {
    const synced = (await db.connections(conn)).filter((x) => x.session_id && x.last_sync).map((x) => x.last_sync).sort();
    const settings = await accountSettings.settings(conn);
    return {
      month: await todayView(conn), fresh_at: synced[0] ?? null,
      // Until payday is set (or the nudge dismissed), offer the one the deposits point to.
      payday_hint: settings.payday || settings.payday_dismissed ? null : await detectPayday(conn),
    };
  })));

  app.get("/api/spending", async (c) => {
    const range = c.req.query("range") ?? "month", off = int(c.req.query("off"), "off", 0);
    if (!spending.RANGES.includes(range) || off > 0) fail(400, RANGE_ERROR);
    return c.json(await db.connect(async (conn) => {
      const v = await spending.view(conn, range, off);
      const cached = await db.getMeta(conn, `explain:${range}:${v.start}`);
      // A read stays until the period's spending changes.
      v.explanation = cached && cached.total === v.total ? cached : null;
      v.ai = await ai.available();
      return v;
    }));
  });

  app.post("/api/spending/explain", async (c) => {
    const b = await body(c, z.object({ range: z.string(), off: integer.default(0) }));
    if (!spending.RANGES.includes(b.range) || b.off > 0) fail(400, RANGE_ERROR);
    if (!(await ai.available())) fail(400, "The assistant needs an Anthropic key. Add your own in Settings.");
    const [v, ctx] = await db.connect(async (conn) => [await spending.view(conn, b.range, b.off), await spending.context(conn, b.range, b.off)] as const);
    let read;
    try {
      read = await ai.explain(ctx);
    } catch (e) {
      if (aiUsage.isAllowanceError(e)) return fail(429, e.message);
      throw e;
    }
    if (!read) fail(502, "The assistant couldn't read this period. Try again in a bit.");
    await db.connect((conn) => db.setMeta(conn, `explain:${b.range}:${v.start}`, { ...read, total: v.total }));
    return c.json(read);
  });

  app.get("/api/spending/category", async (c) => {
    const category = required(c.req.query("category"), "category");
    const range = c.req.query("range") ?? "month", off = int(c.req.query("off"), "off", 0);
    if (!spending.RANGES.includes(range) || off > 0) fail(400, RANGE_ERROR);
    return c.json(await db.connect((conn) => spending.category(conn, category, range, off)));
  });

  app.get("/api/pace", async (c) => c.json(await db.connect((conn) => pace(conn, c.req.query("month") || thisMonth()))));

  app.get("/api/category/:category", async (c) => {
    const category = c.req.param("category");
    if (!(category in CATEGORIES)) fail(404, "Unknown category");
    return c.json(await db.connect((conn) => categoryDetail(conn, category, c.req.query("month") || thisMonth())));
  });

  app.get("/api/service", async (c) => {
    const category = required(c.req.query("category"), "category"), name = required(c.req.query("name"), "name");
    if (!(category in CATEGORIES)) fail(404, "Unknown category");
    return c.json(await db.connect((conn) => serviceDetail(conn, category, name, c.req.query("month") || thisMonth())));
  });

  /** Moves a whole service to another category, now and for future charges from the same merchant. */
  app.post("/api/service/move", async (c) => {
    const b = await body(c, z.object({ category: z.string(), name: z.string(), to: z.string() }));
    if (!(b.to in CATEGORIES)) fail(400, "Unknown category");
    const moved = await db.connect(async (conn) => {
      const ids = await serviceTransactionIds(conn, b.category, b.name);
      const rows = await transactionsRepo.merchantsOf(conn, ids);
      for (const r of rows) await rulesRepo.set(conn, r.merchant || `tx:${r.id}`, b.to);
      await ingest.recategorize(conn);
      return rows.length;
    });
    return c.json({ moved });
  });

  app.get("/api/subscriptions", async (c) => c.json(await db.connect((conn) => subscriptions(conn))));

  app.get("/api/year", async (c) => {
    const y = int(c.req.query("year"), "year", null);
    return c.json(await db.connect((conn) => year(conn, y || clock.serverToday().year)));
  });

  app.post("/api/insights/refresh", async (c) => {
    if (!(await ai.available())) fail(400, "Insights need an Anthropic key. Add your own in Settings.");
    let read;
    try {
      read = await ai.weeklyRead();
    } catch (e) {
      if (aiUsage.isAllowanceError(e)) return fail(429, e.message);
      throw e;
    }
    if (!read) fail(502, "The assistant couldn't write this week's read. Try again in a bit.");
    return c.json(read);
  });
}

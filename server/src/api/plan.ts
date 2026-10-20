/** The monthly plan, its working limits, and settings. */

import type { Hono } from "hono";
import { z } from "zod";

import * as db from "../data/db.js";
import * as ai from "../domain/ai.js";
import * as push from "../integrations/push.js";
import { pyDumps } from "../utils/python.js";
import * as common from "./common.js";
import { body, fail, integer, num } from "./http.js";
import { averages, getPlan, planView, savePlan, setLimit, suggestBudgets } from "../domain/plan.js";
import { committedTotal } from "../domain/commitments.js";
import { detectPayday, setPayday } from "../domain/months.js";
import { extraPay } from "../domain/extra_pay.js";
import * as ingest from "../domain/ingest.js";

const PlanIn = z.object({
  take_home: num, keep: num, budgets: z.record(z.string(), num).nullable().default(null),
  split: z.enum(["auto", "custom"]).nullable().default(null),
});

const SettingsIn = z.object({
  alerts: z.boolean().nullable().optional(),
  weekly_read: z.boolean().nullable().optional(),
  work_hours: num.nullable().optional(),
  payday: z.union([integer, z.literal("last")]).nullable().optional(),  // 1 = calendar months, "last" = last working day
  payday_dismissed: z.boolean().nullable().optional(),
  autofill_dismissed: z.boolean().nullable().optional(),
  assistant_model: z.enum(["haiku", "sonnet", "opus"]).nullable().optional(),
  extra_pay: z.boolean().nullable().optional(),  // 14 salaries a year: Easter, summer and Christmas bonuses
  owner_names: z.array(z.string()).nullable().optional(),  // your names as banks print them: transfers to these are your own
});

export function routes(app: Hono) {
  app.get("/api/plan", async (c) => c.json(await db.connect(async (conn) => ({
    ...(await planView(conn)), committed: await committedTotal(conn),
    settings: await common.settings(conn), devices: await push.count(), ai: await ai.available(),
    payday_detected: await detectPayday(conn), extra_pay: await extraPay(conn),
  }))));

  app.post("/api/plan/suggest", async (c) => {
    const b = await body(c, PlanIn);
    return c.json(await db.connect(async (conn) => ({
      budgets: await suggestBudgets(conn, b.take_home, b.keep), averages: await averages(conn), committed: await committedTotal(conn),
    })));
  });

  app.put("/api/plan", async (c) => {
    const b = await body(c, PlanIn);
    if (b.take_home <= 0 || b.keep < 0 || b.keep >= b.take_home) fail(400, "Keep must be less than take-home");
    await db.connect(async (conn) => {
      if (b.keep + await committedTotal(conn) >= b.take_home) fail(400, "What you keep plus your committed costs leaves nothing to spend");
    });
    return c.json(await db.connect((conn) => savePlan(conn, b.take_home, b.keep, b.budgets, b.split)));
  });

  app.put("/api/plan/limit", async (c) => {
    const b = await body(c, z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), limit: num.refine((v) => v > 0, "Input should be greater than 0") }));
    return c.json(await db.connect(async (conn) => {
      if (!(await getPlan(conn))) fail(400, "Set up the plan first");
      return setLimit(conn, b.month, b.limit);
    }));
  });

  app.put("/api/settings", async (c) => {
    const b = await body(c, SettingsIn);
    if (typeof b.payday === "number" && !(1 <= b.payday && b.payday <= 28)) fail(400, "Payday is a day from 1 to 28, or the last working day");
    const given = Object.fromEntries(Object.entries(b).filter(([, v]) => v != null));
    const merged = await db.connect(async (conn) => {
      const before = await common.settings(conn);
      const out = { ...before, ...given };
      await db.setMeta(conn, "settings", out);
      // transfers to yourself stop (or start) counting as spending
      if (pyDumps(out.owner_names ?? null) !== pyDumps(before.owner_names ?? null)) await ingest.recategorize(conn);
      return out;
    });
    if (b.payday) setPayday(b.payday);
    return c.json(merged);
  });
}

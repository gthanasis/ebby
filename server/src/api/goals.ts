/** Savings goals and the safety net. */

import type { Hono } from "hono";
import { z } from "zod";

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import type { Conn, Row } from "../data/db.js";
import * as habits from "../domain/habits.js";
import * as spending from "../domain/spending.js";
import { median, monthDays, PyDate, pyMod, pyRound, sum } from "../py.js";
import * as goalsRepo from "../data/repos/goals.js";
import * as common from "./common.js";
import { body, fail, int, isoDate, num } from "./http.js";
import { committedTotal } from "../domain/commitments.js";
import { extraPay } from "../domain/extra_pay.js";
import { getPlan } from "../domain/plan.js";
import { localToday, monthBounds, shift, thisMonth } from "../domain/months.js";

function addMonths(d: PyDate, n: number): PyDate {
  const i = d.month - 1 + n;
  const y = d.year + Math.floor(i / 12), m = pyMod(i, 12) + 1;
  return new PyDate(y, m, Math.min(d.day, monthDays(y, m)));
}

/** Suggested until you have a savings total: three months of your fixed costs and usual spending, in a year. */
async function safetyNet(conn: Conn): Promise<Row | null> {
  if (await goalsRepo.hasSavingsTotal(conn)) return null;
  const month = thisMonth();
  let totals: number[] = [];
  for (let i = 1; i < 7; i++) {
    const [a, b] = monthBounds(shift(month, -i));
    const rows = await spending.rows(conn, PyDate.fromisoformat(a), PyDate.fromisoformat(b).addDays(-1));
    totals.push(pyRound(sum(rows.map((r) => r.amount)), 2));
  }
  totals = totals.filter((t) => t > 0);
  if (totals.length < 3) return null;
  const costs = median(totals) + await committedTotal(conn);
  const amount = -Math.floor(-costs * 3 / 100) * 100;
  return { name: "Safety net", price: amount, kind: "save", target_date: addMonths(localToday(), 12).isoformat(), monthly: pyRound(amount / 12, 2) };
}

export function routes(app: Hono) {
  app.get("/api/goals", async (c) => c.json(await db.connect((conn) => common.goals(conn))));

  app.post("/api/goals", async (c) => {
    const b = await body(c, z.object({ name: z.string(), price: num, target_date: isoDate, saved: num.default(0), kind: z.string().default("buy") }));
    if (!b.name.trim() || b.price <= 0 || PyDate.fromisoformat(b.target_date).n <= clock.serverToday().n) fail(400, "A goal needs a name, a price and a date in the future");
    return c.json(await db.connect(async (conn) => {
      await goalsRepo.add(conn, {
        name: b.name.trim(), price: b.price, saved: Math.max(0, b.saved), target_date: b.target_date,
        created_at: clock.serverToday().isoformat(), kind: ["buy", "save"].includes(b.kind) ? b.kind : "buy",
      });
      return common.goals(conn);
    }));
  });

  /** The Goals tab: saving every month (your plan's savings), totals to save, things to buy, and a suggestion. */
  app.get("/api/goals/overview", async (c) => c.json(await db.connect(async (conn) => {
    const plan = await getPlan(conn);
    const items = await common.goals(conn);
    const keep = plan ? plan.keep : 0;
    const monthly = pyRound(keep + sum(items.filter((g) => g.remaining > 0).map((g) => g.monthly)), 2);
    const committed = await committedTotal(conn);
    return {
      save_monthly: plan ? await habits.payYourselfFirst(conn) : null,
      goals: items, monthly, committed,
      take_home: plan ? plan.take_home : null,
      left: plan ? pyRound(plan.take_home - committed - monthly, 2) : null,
      suggestion: await safetyNet(conn),
      extra_pay: await extraPay(conn),
    };
  })));

  app.patch("/api/goals/:goalId", async (c) => {
    const goalId = int(c.req.param("goalId"), "goal_id", 0);
    const b = await body(c, z.object({
      name: z.string().nullable().default(null), price: num.nullable().default(null), target_date: isoDate.nullable().default(null),
      saved: num.nullable().default(null), add: num.nullable().default(null),
    }));
    return c.json(await db.connect(async (conn) => {
      const row = await goalsRepo.get(conn, goalId);
      if (!row) fail(404, "No such goal");
      const g = { ...row! };
      if (b.name != null) g.name = b.name;
      if (b.price != null) g.price = b.price;
      if (b.saved != null) g.saved = b.saved;
      if (b.target_date) g.target_date = b.target_date;
      if (b.add) g.saved = Math.max(0, g.saved + b.add);
      await goalsRepo.update(conn, goalId, { name: g.name, price: g.price, saved: g.saved, target_date: g.target_date });
      return common.goals(conn);
    }));
  });

  app.delete("/api/goals/:goalId", async (c) => {
    const goalId = int(c.req.param("goalId"), "goal_id", 0);
    return c.json(await db.connect(async (conn) => {
      await goalsRepo.remove(conn, goalId);
      return common.goals(conn);
    }));
  });
}

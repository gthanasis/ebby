/** Habits: pay-yourself-first, habit rules, savings accounts, the wishlist, yearly costs. */

import type { Hono } from "hono";
import { z } from "zod";

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import { CATEGORIES } from "../domain/categories.js";
import * as habits from "../domain/habits.js";
import type { HabitRule } from "../types/entities.js";
import { isoUtc } from "../py.js";
import { body, fail, int, integer, num } from "./http.js";

export function routes(app: Hono) {
  app.get("/api/habits", async (c) => c.json(await db.connect((conn) => habits.overview(conn))));

  app.get("/api/habits/weekly", async (c) => c.json(await db.connect((conn) => habits.weekly(conn))));

  app.post("/api/habits/rules", async (c) => {
    const b = await body(c, z.object({ type: z.string(), category: z.string().nullable().default(null), target: num, goal_id: integer.nullable().default(null) }));
    if (!habits.TYPES.includes(b.type) || b.target <= 0) fail(400, "A habit needs a type (fewer, spend_less, nospend or wait) and a target above zero");
    if (b.type === "nospend" && b.target > 7) fail(400, "There are 7 days in a week");
    if (b.type !== "nospend" && !(b.category && b.category in CATEGORIES)) fail(400, "Pick the category it counts");
    return c.json(await db.connect(async (conn) => {
      const id = await habits.addRule(conn, b.type, b.category, b.target, b.goal_id);
      return { id, ...(await habits.weekly(conn)) };
    }));
  });

  app.get("/api/habits/rules/:hid", async (c) => {
    const hid = int(c.req.param("hid"), "hid", 0);
    return c.json(await db.connect(async (conn) => {
      const r = (await conn.execute<HabitRule>("SELECT * FROM habit_rules WHERE id = ?", [hid])).one();
      if (!r) fail(404, "No such habit");
      return habits.habitView(conn, r!, true);
    }));
  });

  app.patch("/api/habits/rules/:hid", async (c) => {
    const hid = int(c.req.param("hid"), "hid", 0);
    const b = await body(c, z.object({ target: num.nullable().default(null), goal_id: integer.nullable().default(null), clear_goal: z.boolean().default(false) }));
    return c.json(await db.connect(async (conn) => {
      if (!(await conn.execute("SELECT * FROM habit_rules WHERE id = ?", [hid])).one()) fail(404, "No such habit");
      if (b.target != null && b.target > 0) await conn.execute("UPDATE habit_rules SET target = ? WHERE id = ?", [b.target, hid]);
      if (b.goal_id != null || b.clear_goal) await conn.execute("UPDATE habit_rules SET goal_id = ? WHERE id = ?", [b.clear_goal ? null : b.goal_id, hid]);
      return habits.habitView(conn, (await conn.execute<HabitRule>("SELECT * FROM habit_rules WHERE id = ?", [hid])).one()!, true);
    }));
  });

  app.delete("/api/habits/rules/:hid", async (c) => {
    const hid = int(c.req.param("hid"), "hid", 0);
    return c.json(await db.connect(async (conn) => {
      await conn.execute("DELETE FROM habit_rules WHERE id = ?", [hid]);
      return habits.weekly(conn);
    }));
  });

  app.put("/api/habits/savings-accounts", async (c) => {
    const b = await body(c, z.object({ ids: z.array(z.string()) }));
    return c.json(await db.connect(async (conn) => {
      await db.setMeta(conn, "savings_accounts", b.ids);
      return habits.overview(conn);
    }));
  });

  app.post("/api/wishlist", async (c) => {
    const b = await body(c, z.object({ name: z.string(), price: num }));
    if (!b.name.trim() || b.price <= 0) fail(400, "Say what it is and what it costs");
    return c.json(await db.connect(async (conn) => {
      await habits.addWish(conn, b.name, b.price);
      return habits.overview(conn);
    }));
  });

  app.post("/api/wishlist/:wid/decide", async (c) => {
    const wid = int(c.req.param("wid"), "wid", 0);
    const b = await body(c, z.object({ decision: z.string() }));
    if (!["bought", "skipped", "goal"].includes(b.decision)) fail(400, "Decision is bought, skipped or goal");
    return c.json(await db.connect(async (conn) => {
      await habits.decideWish(conn, wid, b.decision);
      return habits.overview(conn);
    }));
  });

  app.post("/api/yearly", async (c) => {
    const b = await body(c, z.object({ name: z.string(), yearly_amount: num, due_month: integer }));
    if (!b.name.trim() || b.yearly_amount <= 0 || !(1 <= b.due_month && b.due_month <= 12)) fail(400, "A yearly cost needs a name, an amount and the month it's due");
    return c.json(await db.connect(async (conn) => {
      await conn.execute("INSERT INTO yearly_costs(name, yearly_amount, due_month, created_at) VALUES(?, ?, ?, ?)",
        [b.name.trim(), b.yearly_amount, b.due_month, isoUtc(clock.now())]);
      return habits.overview(conn);
    }));
  });

  app.delete("/api/yearly/:yid", async (c) => {
    const yid = int(c.req.param("yid"), "yid", 0);
    return c.json(await db.connect(async (conn) => {
      await conn.execute("DELETE FROM yearly_costs WHERE id = ?", [yid]);
      return habits.overview(conn);
    }));
  });
}

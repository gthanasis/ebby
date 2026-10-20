/** The monthly plan: take-home, what to keep, and a budget per category, worked out from habits or typed in. */

import * as db from "../data/db.js";
import { type Conn, first, type Row } from "../data/db.js";
import { maxBy, median, pyRound, sum } from "../py.js";
import type { Payday, Plan } from "../types/entities.js";
import { SPENDING } from "./categories.js";
import { SPEND_ARGS, SPEND_SQL } from "./spend_sql.js";
import { committedTotal } from "./commitments.js";
import { detectPayday, monthBounds, setPayday, shift, thisMonth } from "./months.js";

// Trimmed harder when income doesn't cover habits; essentials barely move.
const DISCRETIONARY: Record<string, number> = {
  eating_out: 1.0, delivery: 1.0, shopping: 1.0, cash: 1.0, coffee_bars: 1.0,
  leisure: 1.0, subscriptions: 0.8, other: 0.8, travel: 0.8, people: 0.6,
  personal_care: 0.6, pets: 0.3, car: 0.4, health: 0.2, groceries: 0.3,
  bills: 0.1, housing: 0.0, fees: 0.5, loans: 0.0, insurance: 0.1, kids: 0.2,
  education: 0.3, gifts: 0.8,
};

/** Average monthly spend per category over the last `months` complete months. */
export async function averages(conn: Conn, months = 6): Promise<Record<string, number>> {
  const end = monthBounds(thisMonth())[0];
  const start = monthBounds(shift(thisMonth(), -months))[0];
  const rows = (await conn.execute(`
    SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
  return Object.fromEntries(rows.map((r) => [r.category, Math.max(0.0, r.spent / months)]));
}

const round10 = (v: number) => Math.max(10.0, pyRound(v / 10) * 10);
export const roundTo = (v: number, step: number) => pyRound(v / step) * step;

/** Splits take-home minus savings across categories. When habits cost more than that, discretionary categories
 * are trimmed hardest (never below 20% of their average). */
export async function suggestBudgets(conn: Conn, takeHome: number, keep: number): Promise<Record<string, number>> {
  const avg = Object.fromEntries(Object.entries(await averages(conn)).filter(([, a]) => a >= 5));
  const spendable = Math.max(0.0, takeHome - keep - await committedTotal(conn));
  if (!Object.keys(avg).length) return {};
  if (sum(Object.values(avg)) <= spendable) return Object.fromEntries(Object.entries(avg).map(([c, a]) => [c, round10(a)]));
  const total = (f: number) => sum(Object.entries(avg).map(([c, a]) => a * Math.max(0.2, 1 - f * (DISCRETIONARY[c] ?? 0.7))));
  let lo = 0.0, hi = 5.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > spendable) lo = mid; else hi = mid;
  }
  return Object.fromEntries(Object.entries(avg).map(([c, a]) => [c, round10(a * Math.max(0.2, 1 - hi * (DISCRETIONARY[c] ?? 0.7)))]));
}

export const getPlan = (conn: Conn) => db.getMeta(conn, "plan");

/** The habit-based split, scaled so it adds up to exactly what's free to spend. */
export async function autoBudgets(conn: Conn, takeHome: number, keep: number): Promise<Record<string, number>> {
  const split = await suggestBudgets(conn, takeHome, keep);
  const spendable = Math.max(0.0, takeHome - keep - await committedTotal(conn));
  const total = sum(Object.values(split));
  if (!Object.keys(split).length || !total || !spendable) return {};
  const out: Record<string, number> = Object.fromEntries(Object.entries(split).map(([c, v]) => [c, pyRound(v * spendable / total)]));
  const biggest = maxBy(Object.keys(out), (c) => out[c])!;
  out[biggest] += pyRound(spendable - sum(Object.values(out)));  // rounding leftovers go to the biggest
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0));
}

/** split "auto" keeps the budgets following income, savings and fixed costs; "custom" keeps what you typed. Left
 * out, the plan keeps the split it had (plans from before this were custom). */
export async function savePlan(conn: Conn, takeHome: number, keep: number, budgets: Record<string, number> | null,
                               split: Plan["split"] | null = null): Promise<Plan> {
  const current: Partial<Plan> = (await getPlan(conn)) || {};
  split = split || current.split || (budgets == null ? "auto" : "custom");
  if (split === "auto") budgets = await autoBudgets(conn, takeHome, keep);
  const chosen: Record<string, number> = (budgets && Object.keys(budgets).length ? budgets : null) || current.budgets || {};
  const plan: Plan = {
    take_home: takeHome, keep, split,
    budgets: Object.fromEntries(Object.entries(chosen).filter(([c, v]) => SPENDING.has(c) && v > 0).map(([c, v]) => [c, Number(v)])),
    limits: current.limits ?? {},
  };
  await db.setMeta(conn, "plan", plan);
  return plan;
}

/** After fixed costs change, an automatic split follows them. */
export async function resplit(conn: Conn) {
  const plan = await getPlan(conn);
  if (plan && plan.split === "auto") await savePlan(conn, plan.take_home, plan.keep, null, "auto");
}

/** After the first import, set the plan up from what the transactions show: pay and payday from the salary
 * deposits, savings from what has actually gone into savings accounts, and an automatic split. Does nothing once a
 * plan exists. Settings records it so the app can say so once. */
export async function autofill(conn: Conn): Promise<boolean> {
  if (await getPlan(conn)) return false;
  const pay = await detectPayday(conn);
  if (!pay) return false;
  const habits = await import("./habits.js");
  const day: Payday = pay.day <= 28 ? pay.day : "last";
  await db.setMeta(conn, "settings", { ...((await db.getMeta(conn, "settings")) || {}), payday: day, autofilled: true });
  setPayday(day);
  const takeHome = pyRound(pay.amount);
  const ids = await habits.savingsAccountIds(conn);
  let keep = 0.0;
  if (ids.length) {
    // What goes into savings each month. Money comes back out between paydays, so the net swings wildly; the
    // typical amount moved in is what you mean to put aside.
    const moved: number[] = [];
    for (let i = 1; i < 4; i++) {
      const [ms, me] = monthBounds(shift(thisMonth(), -i));
      moved.push(first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN (${ids.map(() => "?").join(",")})
                                   AND amount > 0 AND date >= ? AND date < ? AND duplicate_of IS NULL AND currency = 'EUR'`,
        [...ids, ms, me])).one()));
    }
    keep = Math.max(0.0, roundTo(median(moved), 50));
  }
  if (keep + await committedTotal(conn) >= takeHome) keep = 0.0;
  await savePlan(conn, takeHome, keep, null, "auto");
  return true;
}

/** The budgets that apply to a pay month. The plan's budgets are the goal; a month can carry a working limit on the
 * way down to it, which scales every budget in proportion. */
export function budgetsFor(plan: Pick<Plan, "budgets"> & Partial<Plan> | null, month: string): Record<string, number> {
  if (!plan) return {};
  const goal = sum(Object.values(plan.budgets));
  const limit = (plan.limits || {})[month];
  if (!limit || !goal) return { ...plan.budgets };
  const scaled: Record<string, number> = Object.fromEntries(Object.entries(plan.budgets).map(([c, v]) => [c, pyRound(v * limit / goal, 2)]));
  // Rounding each budget drifts by cents; the biggest absorbs it, so they add up to the limit you set.
  const drift = pyRound(limit - sum(Object.values(scaled)), 2);
  if (drift && Object.keys(scaled).length) {
    const biggest = maxBy(Object.keys(scaled), (c) => [scaled[c], c])!;
    scaled[biggest] = pyRound(scaled[biggest] + drift, 2);
  }
  return scaled;
}

export async function setLimit(conn: Conn, month: string, limit: number): Promise<Plan> {
  const plan = (await getPlan(conn))!;
  plan.limits = plan.limits || {};
  plan.limits[month] = Number(limit);
  await db.setMeta(conn, "plan", plan);
  return plan;
}

export async function planView(conn: Conn): Promise<Row> {
  const plan = await getPlan(conn);
  const avg = await averages(conn);
  if (!plan) return { plan: null, averages: avg };
  return { plan, averages: avg, total: sum(Object.values<number>(plan.budgets)) };
}

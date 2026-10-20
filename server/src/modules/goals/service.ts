/** Goals: what a goal needs a week and a month, and where that money can come from. */

import * as clock from "../../shared/clock.js";
import { type Conn, type Row } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { fmt0, PyDate, pyRound, sorted } from "../../shared/utils/python.js";
import type { Goal } from "../../types/entities.js";
import { monthBounds, shift, thisMonth } from "../../shared/months.js";
import { subscriptions } from "../spending/subscriptions.js";
import * as goalsRepo from "./repo.js";

export async function goalView(conn: Conn, goal: Goal): Promise<Row> {
  const remaining = Math.max(0.0, goal.price - goal.saved);
  const days = Math.max(1, PyDate.fromisoformat(goal.target_date).diffDays(clock.serverToday()));
  const weekly = remaining / (days / 7);
  const monthly = remaining / (days / 30.44);
  return {
    ...goal, remaining: pyRound(remaining, 2), weeks_left: Math.max(1, pyRound(days / 7)),
    weekly: pyRound(weekly, 2), monthly: pyRound(monthly, 2), cuts: await cuts(conn, monthly),
  };
}

/** Concrete changes from your last 3 months, biggest first, until they cover the goal. */
export async function cuts(conn: Conn, neededMonthly: number): Promise<Row[]> {
  const start = monthBounds(shift(thisMonth(), -3))[0];
  const end = monthBounds(thisMonth())[0];
  const stats = new Map((await transactionsRepo.threeMonthHabits(conn, start, end)).map((r) => [r.category, r]));
  const options: Row[] = [];
  const d = stats.get("delivery"), e = stats.get("eating_out"), c = stats.get("coffee_bars"), s = stats.get("shopping"), x = stats.get("cash");
  if (d && d.per_month >= 4) options.push({ category: "delivery", text: "1 fewer delivery a week", detail: `you average €${fmt0(d.avg)} an order`, monthly: pyRound(d.avg * 4.33, 2) });
  if (e && e.per_month >= 4) options.push({ category: "eating_out", text: "Eat out 3 fewer times a month", detail: `€${fmt0(e.avg)} a meal`, monthly: pyRound(e.avg * 3, 2) });
  if (c && c.per_month >= 6) options.push({ category: "coffee_bars", text: "Skip a third of coffee and bar visits", detail: `€${fmt0(c.avg)} a visit`, monthly: pyRound(c.monthly / 3, 2) });
  if (s && s.monthly >= 100) options.push({ category: "shopping", text: "Cut shopping by a quarter", detail: `usually €${fmt0(s.monthly)} a month`, monthly: pyRound(s.monthly / 4, 2) });
  if (x && x.monthly >= 200) options.push({ category: "cash", text: "Withdraw €50 less cash a week", detail: `usually €${fmt0(x.monthly)} a month in cash`, monthly: pyRound(50 * 4.33, 2) });
  const subs = await subscriptions(conn);
  for (const sub of subs.items.filter((t: Row) => !t.stale && t.monthly >= 8).slice(0, 2)) {
    options.push({ category: "subscriptions", text: `Pause ${sub.name} until then`, detail: "charged monthly", monthly: sub.monthly });
  }
  // Small, specific habits first (they stick); the blunt levers only if those aren't enough.
  const order = ["delivery", "eating_out", "subscriptions", "coffee_bars", "shopping", "cash"];
  const chosen: Row[] = [];
  let total = 0.0;
  for (const o of sorted(options, (o) => [order.indexOf(o.category), -o.monthly])) {
    if (total >= neededMonthly && chosen.length >= 2) break;
    chosen.push(o);
    total += o.monthly;
  }
  return chosen;
}

/** Every goal with its progress, soonest first. */
export async function goalsList(conn: Conn): Promise<Row[]> {
  const out = [];
  for (const r of await goalsRepo.all(conn)) out.push(await goalView(conn, r));
  return out;
}

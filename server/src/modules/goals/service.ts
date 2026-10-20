/** Goals: what a goal needs a week and a month, and where that money can come from. */

import * as clock from "../../shared/clock.js";
import { type Conn, type Row } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { fmt0, pyRound, sorted } from "../../shared/utils/python.js";
import type { Goal } from "../../types/entities.js";
import { monthBounds, shift, thisMonth } from "../../shared/months.js";
import { subscriptions } from "../spending/subscriptions.js";
import { type Cut, type Goal as GoalView, needs, toGoal } from "./converters.js";
import * as goalsRepo from "./repo.js";

export async function goalView(conn: Conn, goal: Goal): Promise<GoalView> {
  const n = needs(goal, clock.serverToday());
  return toGoal(goal, n, await cuts(conn, n.monthly));
}

type HabitStats = Awaited<ReturnType<typeof transactionsRepo.threeMonthHabits>>[number];

/** A change worth suggesting when the last 3 months of a category show the habit. */
interface CutRule {
  category: string;
  applies: (s: HabitStats) => boolean;
  text: string;
  detail: (s: HabitStats) => string;
  monthly: (s: HabitStats) => number;
}

const CUT_RULES: CutRule[] = [
  { category: "delivery", applies: (s) => s.per_month >= 4, text: "1 fewer delivery a week",
    detail: (s) => `you average €${fmt0(s.avg)} an order`, monthly: (s) => pyRound(s.avg * 4.33, 2) },
  { category: "eating_out", applies: (s) => s.per_month >= 4, text: "Eat out 3 fewer times a month",
    detail: (s) => `€${fmt0(s.avg)} a meal`, monthly: (s) => pyRound(s.avg * 3, 2) },
  { category: "coffee_bars", applies: (s) => s.per_month >= 6, text: "Skip a third of coffee and bar visits",
    detail: (s) => `€${fmt0(s.avg)} a visit`, monthly: (s) => pyRound(s.monthly / 3, 2) },
  { category: "shopping", applies: (s) => s.monthly >= 100, text: "Cut shopping by a quarter",
    detail: (s) => `usually €${fmt0(s.monthly)} a month`, monthly: (s) => pyRound(s.monthly / 4, 2) },
  { category: "cash", applies: (s) => s.monthly >= 200, text: "Withdraw €50 less cash a week",
    detail: (s) => `usually €${fmt0(s.monthly)} a month in cash`, monthly: () => pyRound(50 * 4.33, 2) },
];

/** Concrete changes from your last 3 months, biggest first, until they cover the goal. */
export async function cuts(conn: Conn, neededMonthly: number): Promise<Cut[]> {
  const start = monthBounds(shift(thisMonth(), -3))[0];
  const end = monthBounds(thisMonth())[0];
  const stats = new Map((await transactionsRepo.threeMonthHabits(conn, start, end)).map((r) => [r.category, r]));
  const options: Cut[] = [];
  for (const rule of CUT_RULES) {
    const st = stats.get(rule.category);
    if (st && rule.applies(st)) options.push({ category: rule.category, text: rule.text, detail: rule.detail(st), monthly: rule.monthly(st) });
  }
  const subs = await subscriptions(conn);
  for (const sub of subs.items.filter((t: Row) => !t.stale && t.monthly >= 8).slice(0, 2)) {
    options.push({ category: "subscriptions", text: `Pause ${sub.name} until then`, detail: "charged monthly", monthly: sub.monthly });
  }
  // Small, specific habits first (they stick); the blunt levers only if those aren't enough.
  const order = ["delivery", "eating_out", "subscriptions", "coffee_bars", "shopping", "cash"];
  const chosen: Cut[] = [];
  let total = 0.0;
  for (const o of sorted(options, (o) => [order.indexOf(o.category), -o.monthly])) {
    if (total >= neededMonthly && chosen.length >= 2) break;
    chosen.push(o);
    total += o.monthly;
  }
  return chosen;
}

/** Every goal with its progress, soonest first. */
export async function goalsList(conn: Conn): Promise<GoalView[]> {
  const out = [];
  for (const r of await goalsRepo.all(conn)) out.push(await goalView(conn, r));
  return out;
}

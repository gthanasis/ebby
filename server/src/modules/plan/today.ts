/** The Home card: today, this week and this pay month against the plan. */

import { type Conn } from "../../shared/db.js";
import * as goalsRepo from "../goals/repo.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import { getPlan } from "./service.js";
import { categoryRows } from "./pace.js";
import { committedTotal, fixedMonth } from "../commitments/service.js";
import { localToday, monthBounds, shift, thisMonth } from "../../shared/months.js";
import * as spending from "../spending/service.js";
import { type Ideal, type TodayMonth, toIdeal, toIdealGoal, toTodayMonth } from "./converters.js";

/** Spending from start up to and including end. */
export async function spentBetween(conn: Conn, start: PyDate, end: PyDate): Promise<number> {
  return pyRound(await transactionsRepo.spentThrough(conn, start.isoformat(), end.isoformat()), 2);
}

/** This pay month so far, for Today: each day's spending, the average day, where the month ends at that pace,
 * and where the money went. Everything counts the same days (the start of the month up to and including today),
 * so the totals agree. */
export async function todayView(conn: Conn): Promise<TodayMonth> {
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const length = end.diffDays(firstDay);
  const byDay = new Map((await transactionsRepo.spentPerDayThrough(conn, firstDay.isoformat(), today.isoformat()))
    .map((r) => [r.date, pyRound(r.spent, 2)]));
  // Fixed costs stay out of the days' spending; each day says what went to them, so the chart can mark it.
  const fixedByDay = new Map<string, number>();
  for (const r of await transactionsRepo.fixedRows(conn, firstDay.isoformat(), today.isoformat())) {
    fixedByDay.set(r.date, (fixedByDay.get(r.date) ?? 0) + r.amount);
  }
  const days = Array.from({ length }, (_, i) => firstDay.addDays(i)).map((d) => ({
    date: d.isoformat(), spent: d.n <= today.n ? (byDay.get(d.isoformat()) ?? 0.0) : null,
    fixed: pyRound(fixedByDay.get(d.isoformat()) ?? 0, 2),
  }));
  const spent = pyRound(sum(byDay.values()), 2);
  const elapsed = today.diffDays(firstDay) + 1;
  const rows = await categoryRows(conn, firstDay.isoformat(), today.addDays(1).isoformat());
  const categories = sorted([...rows.entries()].filter(([, r]) => r.spent > 0).map(([c, r]) => ({ category: c, ...r })), (c) => -c.spent);
  const plan = await getPlan(conn);
  const goal = (await goalsRepo.progress(conn)).find((g) => g.saved < g.price && g.target_date >= today.isoformat()) ?? null;
  // What to cut first: categories at least €20 over what a usual month has spent by now, furthest over first.
  type Usual = { category: string; spent: number; usual: number; count: number };
  const usual: Usual[] = (await spending.view(conn, "month", 0)).categories ?? [];
  const watch = sorted(usual.filter((c) => c.spent - c.usual >= 20), (c) => [c.usual - c.spent, c.category])
    .slice(0, 2).map((c) => ({ category: c.category, spent: c.spent, usual: c.usual, count: c.count }));
  return toTodayMonth({ month, firstDay, end, today, length, elapsed, spent, days, categories, ideal: await ideal(conn, length, month),
    fixed: await fixedMonth(conn, month), next_limit: plan?.limits?.[shift(month, 1)] ?? null,
    goal: goal && { id: goal.id, name: goal.name, price: goal.price, saved: goal.saved, target_date: goal.target_date }, watch });
}

/** What the month should look like: income less savings, fixed costs and what each goal needs a month, shared
 * over the days and across categories in the plan's proportions. */
async function ideal(conn: Conn, length: number, month: string): Promise<Ideal | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const goals = [];
  for (const r of await goalsRepo.progress(conn)) goals.push(toIdealGoal(r, localToday()));
  return toIdeal(plan, await committedTotal(conn), goals, length, plan.limits?.[month]);
}

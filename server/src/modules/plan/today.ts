/** The Home card: today, this week and this pay month against the plan. */

import { type Conn, type Row } from "../../shared/db.js";
import * as goalsRepo from "../goals/repo.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import { getPlan } from "./service.js";
import { categoryRows } from "./pace.js";
import { committedTotal } from "../commitments/service.js";
import { localToday, monthBounds, thisMonth } from "../../shared/months.js";

/** Spending from start up to and including end. */
export async function spentBetween(conn: Conn, start: PyDate, end: PyDate): Promise<number> {
  return pyRound(await transactionsRepo.spentThrough(conn, start.isoformat(), end.isoformat()), 2);
}

/** This pay month so far, for Today: each day's spending, the average day, where the month ends at that pace,
 * and where the money went. Everything counts the same days (the start of the month up to and including today),
 * so the totals agree. */
export async function todayView(conn: Conn): Promise<Row> {
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const length = end.diffDays(firstDay);
  const byDay = new Map((await transactionsRepo.spentPerDayThrough(conn, firstDay.isoformat(), today.isoformat()))
    .map((r) => [r.date, pyRound(r.spent, 2)]));
  const days = Array.from({ length }, (_, i) => firstDay.addDays(i)).map((d) => ({
    date: d.isoformat(), spent: d.n <= today.n ? (byDay.get(d.isoformat()) ?? 0.0) : null,
  }));
  const spent = pyRound(sum(byDay.values()), 2);
  const elapsed = today.diffDays(firstDay) + 1;
  const rows = await categoryRows(conn, firstDay.isoformat(), today.addDays(1).isoformat());
  const categories = sorted([...rows.entries()].filter(([, r]) => r.spent > 0).map(([c, r]) => ({ category: c, ...r })), (c) => -c.spent);
  return {
    month, start: firstDay.isoformat(), end: end.isoformat(), today: today.isoformat(),
    length, elapsed, spent, days,
    average: pyRound(spent / elapsed, 2), projected: pyRound(spent / elapsed * length, 2),
    categories, ideal: await ideal(conn, length),
  };
}

/** What the month should look like: income less savings, fixed costs and what each goal needs a month, shared
 * over the days and across categories in the plan's proportions. */
async function ideal(conn: Conn, length: number): Promise<Row | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const goals = [];
  for (const r of await goalsRepo.progress(conn)) {
    const daysLeft = Math.max(1, PyDate.fromisoformat(r.target_date).diffDays(localToday()));
    goals.push({ name: r.name, price: r.price, target_date: r.target_date, monthly: pyRound(Math.max(0.0, r.price - r.saved) / (daysLeft / 30.44), 2) });
  }
  const fixed = await committedTotal(conn);
  const budget = Math.max(0.0, plan.take_home - plan.keep - fixed - sum(goals.map((g) => g.monthly)));
  const shares: Record<string, number> = plan.budgets;
  const total = sum(Object.values(shares));
  return {
    income: plan.take_home, savings: plan.keep, fixed, goals,
    budget: pyRound(budget, 2), day: pyRound(budget / length, 2),
    targets: total ? Object.fromEntries(Object.entries(shares).map(([c, v]) => [c, pyRound(v * budget / total, 2)])) : {},
  };
}

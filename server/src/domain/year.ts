/** A year of free spending, month by month and by category. */

import { type Conn, type Row } from "../data/db.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { maxBy, pyRound, sorted, sum } from "../py.js";
import { getPlan } from "./plan.js";
import { monthBounds, monthOf } from "./months.js";

export async function year(conn: Conn, y: number): Promise<Row> {
  const start = monthBounds(`${y}-01`)[0], end = monthBounds(`${y}-12`)[1];
  const months = await monthsSpent(conn, start, end);
  const cats = await transactionsRepo.categoriesBySpent(conn, start, end);
  const total = pyRound(sum(months.map((m) => m.spent)), 2);
  const plan = await getPlan(conn);
  const monthlyPlan = plan ? sum(Object.values<number>(plan.budgets)) : null;
  const peak = months.length ? maxBy(months, (m) => m.spent)! : null;
  let peakCat = null;
  if (peak) {
    const [ps, pe] = monthBounds(peak.month);
    peakCat = await transactionsRepo.topCategory(conn, ps, pe) ?? null;
  }
  const under = months.filter((m) => monthlyPlan && m.spent <= monthlyPlan).map((m) => m.month);
  const committed = await transactionsRepo.committed(conn, start, end);
  return {
    year: y, total, months, categories: cats,
    monthly_average: months.length ? pyRound(total / months.length, 2) : 0,
    monthly_plan: monthlyPlan, peak, peak_category: peakCat, under_plan: under,
    committed: pyRound(committed, 2),
    years: await transactionsRepo.years(conn),
  };
}

/** Free spending per pay month between two days, oldest first. */
async function monthsSpent(conn: Conn, start: string, end: string): Promise<{ month: string; spent: number }[]> {
  const by = new Map<string, number>();
  for (const r of await transactionsRepo.spentPerDay(conn, start, end)) {
    const m = monthOf(r.date);
    by.set(m, (by.get(m) ?? 0) + r.spent);
  }
  return sorted(by.entries(), ([m]) => m).map(([m, v]) => ({ month: m, spent: pyRound(v, 2) }));
}

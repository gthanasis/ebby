/** A year of free spending, month by month and by category. */

import { type Conn } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { maxBy, pyRound, sorted, sum } from "../../shared/utils/python.js";
import { getPlan } from "./service.js";
import { monthBounds, monthOf } from "../../shared/months.js";
import { toYear, type Year } from "./converters.js";

export async function year(conn: Conn, y: number): Promise<Year> {
  const start = monthBounds(`${y}-01`)[0], end = monthBounds(`${y}-12`)[1];
  const months = await monthsSpent(conn, start, end);
  const cats = await transactionsRepo.categoriesBySpent(conn, start, end);
  const plan = await getPlan(conn);
  const monthlyPlan = plan ? sum(Object.values<number>(plan.budgets)) : null;
  const peak = months.length ? maxBy(months, (m) => m.spent)! : null;
  let peakCat = null;
  if (peak) {
    const [ps, pe] = monthBounds(peak.month);
    peakCat = await transactionsRepo.topCategory(conn, ps, pe) ?? null;
  }
  const committed = await transactionsRepo.committed(conn, start, end);
  return toYear({
    year: y, months, categories: cats, monthlyPlan, peak, peakCategory: peakCat, committed, years: await transactionsRepo.years(conn),
  });
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

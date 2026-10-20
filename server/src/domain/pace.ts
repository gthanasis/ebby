/** Pace: a pay month's spending against the plan, category by category, in plain words. */

import { type Conn, type Row } from "../data/db.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { fmt0, pyRound, sorted, sum } from "../py.js";
import { dayProgress, monthBounds, thisMonth } from "./months.js";
import { budgetsFor, getPlan } from "./plan.js";

export async function categoryRows(conn: Conn, start: string, end: string): Promise<Map<string, { spent: number; count: number }>> {
  const rows = await transactionsRepo.spentAndCountByCategory(conn, start, end);
  return new Map(rows.map((r) => [r.category, { spent: pyRound(r.spent, 2), count: r.count }]));
}

/** The habit behind a number, in plain words. */
export function habit(category: string, spent: number, count: number, budget: number | null | undefined, elapsed: number): string {
  const weeks = Math.max(1.0, elapsed / 7);
  const per = count ? spent / count : 0;
  const plan = budget ? ` Plan was €${fmt0(budget)}.` : "";
  if (category === "delivery") return `${count} orders, about ${fmt0(count / weeks, false)} a week.${plan}`;
  if (category === "eating_out" || category === "coffee_bars") {
    const word = category === "eating_out" ? "meals" : "visits";
    return `${count} ${word}, €${fmt0(per)} each.${plan}`;
  }
  if (category === "cash") return `${count} withdrawals, €${fmt0(per)} each.${plan}`;
  return `${count} payments, €${fmt0(per)} on average.${plan}`;
}

export async function pace(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const [elapsed, days] = dayProgress(month);
  const plan = await getPlan(conn);
  const budgets = budgetsFor(plan, month);
  const rows = await categoryRows(conn, start, end);
  const total = pyRound(sum([...rows.values()].map((r) => r.spent)), 2);
  const planned = plan ? pyRound(sum(Object.values(budgets)), 2) : null;
  const expected = planned ? planned * elapsed / days : null;

  const categories = [];
  // Ties (nothing spent yet) by name: a set's order changes from one process to the next.
  const all = new Set([...rows.keys(), ...Object.keys(budgets)]);
  for (const cat of sorted(all, (c) => [-(rows.get(c)?.spent ?? 0), c])) {
    const r = rows.get(cat) ?? { spent: 0.0, count: 0 };
    const budget = budgets[cat];
    let status = "none";
    if (budget) {
      if (r.spent > budget) status = "over";
      else if (elapsed && r.spent > budget * elapsed / days * 1.15 && r.spent - budget * elapsed / days > 25) status = "ahead";
      else status = "fine";
    }
    categories.push({
      category: cat, spent: r.spent, count: r.count, budget: budget ?? null, status,
      habit: r.count ? habit(cat, r.spent, r.count, budget, elapsed) : "",
    });
  }
  const projected = elapsed && month === thisMonth() ? pyRound(total / elapsed * days, 2) : total;
  return {
    month, start, end, elapsed, days, total, planned,
    expected_to_date: expected != null ? pyRound(expected, 2) : null,
    projected, take_home: plan?.take_home ?? null,
    categories,
  };
}

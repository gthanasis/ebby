/** The plan's views as the API shows them, from what was read: pure, no database. */

import type { z } from "zod";

import { maxBy, median, PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import type { Plan } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type ExtraPay = z.infer<typeof S.ExtraPay>;
export type PaydayGuess = z.infer<typeof S.PaydayGuess>;
export type PaceCategory = z.infer<typeof S.PaceCategory>;
export type Pace = z.infer<typeof S.Pace>;
export type Ideal = z.infer<typeof S.Ideal>;
export type TodayMonth = z.infer<typeof S.TodayMonth>;
export type CategoryDetail = z.infer<typeof S.CategoryDetail>;
export type Year = z.infer<typeof S.Year>;

type IdealGoal = Ideal["goals"][number];
type MonthSpent = Year["months"][number];

/** The day pay lands on, from the deposits that voted for it. */
export function toPaydayGuess(day: number, hits: { date: string; amount: number }[]): PaydayGuess {
  const last = maxBy(hits, (r) => r.date)!;
  return { day, amount: pyRound(median(hits.map((r) => r.amount)), 2), last: last.date, months: hits.length };
}

export function toPaceCategory(category: string, r: { spent: number; count: number }, budget: number | undefined,
                               status: PaceCategory["status"], habit: string): PaceCategory {
  return { category, spent: r.spent, count: r.count, budget: budget ?? null, status, habit };
}

/** What a goal needs a month to be reached by its date. */
export function toIdealGoal(r: { name: string; price: number; saved: number; target_date: string }, today: PyDate): IdealGoal {
  const daysLeft = Math.max(1, PyDate.fromisoformat(r.target_date).diffDays(today));
  return { name: r.name, price: r.price, target_date: r.target_date, monthly: pyRound(Math.max(0.0, r.price - r.saved) / (daysLeft / 30.44), 2) };
}

/** Income less savings, fixed costs and the goals, shared over the days and across categories in the plan's proportions. */
export function toIdeal(plan: Plan, fixed: number, goals: IdealGoal[], length: number): Ideal {
  const budget = Math.max(0.0, plan.take_home - plan.keep - fixed - sum(goals.map((g) => g.monthly)));
  const shares: Record<string, number> = plan.budgets;
  const total = sum(Object.values(shares));
  return {
    income: plan.take_home, savings: plan.keep, fixed, goals,
    budget: pyRound(budget, 2), day: pyRound(budget / length, 2),
    targets: total ? Object.fromEntries(Object.entries(shares).map(([c, v]) => [c, pyRound(v * budget / total, 2)])) : {},
  };
}

export function toTodayMonth(v: {
  month: string; firstDay: PyDate; end: PyDate; today: PyDate; length: number; elapsed: number; spent: number;
  days: TodayMonth["days"]; categories: TodayMonth["categories"]; ideal: Ideal | null;
}): TodayMonth {
  return {
    month: v.month, start: v.firstDay.isoformat(), end: v.end.isoformat(), today: v.today.isoformat(),
    length: v.length, elapsed: v.elapsed, spent: v.spent, days: v.days,
    average: pyRound(v.spent / v.elapsed, 2), projected: pyRound(v.spent / v.elapsed * v.length, 2),
    categories: v.categories, ideal: v.ideal,
  };
}

export function toCategoryDetail(category: string, month: string, budget: number | null, history: MonthSpent[],
                                 services: Map<string, { amount: number; count: number; accounts: Set<string> }>): CategoryDetail {
  return {
    category, month, budget, history,
    spent: pyRound(sum([...services.values()].map((s) => s.amount)), 2),
    services: sorted([...services.entries()].filter(([, s]) => s.amount > 0).map(([n, s]) => ({
      name: n, amount: pyRound(s.amount, 2), count: s.count, accounts: sorted(s.accounts),
    })), (s) => -s.amount),
  };
}

export function toYear(v: {
  year: number; months: MonthSpent[]; categories: Year["categories"]; monthlyPlan: number | null; peak: MonthSpent | null;
  peakCategory: Year["peak_category"]; committed: number; years: string[];
}): Year {
  const total = pyRound(sum(v.months.map((m) => m.spent)), 2);
  return {
    year: v.year, total, months: v.months, categories: v.categories,
    monthly_average: v.months.length ? pyRound(total / v.months.length, 2) : 0,
    monthly_plan: v.monthlyPlan, peak: v.peak, peak_category: v.peakCategory,
    under_plan: v.months.filter((m) => v.monthlyPlan && m.spent <= v.monthlyPlan).map((m) => m.month),
    committed: pyRound(v.committed, 2),
    years: v.years,
  };
}

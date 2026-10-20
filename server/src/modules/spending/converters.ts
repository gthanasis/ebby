/** Spending, services, subscriptions and cash as the API shows them: pure, no database. */

import type { z } from "zod";

import { pyRound, sorted, sum } from "../../shared/utils/python.js";
import type * as S from "./schemas.js";

export type SpendPayment = z.infer<typeof S.SpendPayment>;
export type SpendCategory = z.infer<typeof S.SpendCategory>;
export type ServiceDetail = z.infer<typeof S.ServiceDetail>;
export type Subscription = z.infer<typeof S.Subscription>;
export type Subscriptions = z.infer<typeof S.Subscriptions>;
export type Cash = z.infer<typeof S.Cash>;

/** A spending row (amount as a positive number) under the service it went to. */
export function toSpendPayment(r: { date: string; amount: number; category: string }, name: string): SpendPayment {
  return { date: r.date, amount: pyRound(r.amount, 2), category: r.category, name };
}

/** One category over a period; usualMonth is the unrounded median of the months before. */
export function toSpendCategory(
  period: Pick<SpendCategory, "category" | "range" | "off" | "key" | "start" | "end" | "month">,
  total: number, count: number, usualMonth: number, history: SpendCategory["history"], services: Map<string, [number, number]>,
): SpendCategory {
  return {
    category: period.category, range: period.range, off: period.off, key: period.key, start: period.start, end: period.end, month: period.month,
    total, count, usual_month: pyRound(usualMonth, 2),
    history,
    services: sorted([...services.entries()].map(([n, [v, c]]) => ({ name: n, spent: pyRound(v, 2), count: c })), (s) => -s.spent),
  };
}

/** One service over a pay month: weekdays are unrounded sums, busiest is [payments, day] pairs. */
export function toServiceDetail(
  category: string, name: string, month: string, spent: number, count: number, categoryTotal: number,
  history: ServiceDetail["history"], weekdays: number[], busiest: [number, string][],
): ServiceDetail {
  return {
    category, name, month, spent, count,
    average: count ? pyRound(spent / count, 2) : 0,
    share: categoryTotal > 0 ? pyRound(spent / categoryTotal, 3) : null,
    history, weekdays: weekdays.map((v) => pyRound(v, 2)),
    busiest_days: sorted(busiest, (x) => x[1]).map(([n, d]) => ({ date: d, count: n })),
  };
}

/** Active ones first, biggest first; the totals count only the active. */
export function toSubscriptions(items: Subscription[]): Subscriptions {
  const ordered = sorted(items, (s) => [s.stale ? 1 : 0, -s.monthly]);
  const active = ordered.filter((s) => !s.stale);
  const monthly = pyRound(sum(active.map((s) => s.monthly)), 2);
  return { items: ordered, monthly, yearly: pyRound(monthly * 12, 2), count: active.length };
}

export function toCash(withdrawn: number, logged: number): Cash {
  return { withdrawn: pyRound(withdrawn, 2), logged: pyRound(logged, 2), unaccounted: pyRound(Math.max(0, withdrawn - logged), 2) };
}

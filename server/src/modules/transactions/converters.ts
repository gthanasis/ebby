/** Categories, the overview and the transaction list as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import type { Row } from "../../shared/db.js";
import { pyRound, sorted } from "../../shared/utils/python.js";
import type * as S from "./schemas.js";

export type Category = z.infer<typeof S.Category>;
export type Overview = z.infer<typeof S.Overview>;
export type Transaction = z.infer<typeof S.Transaction>;
export type TransactionPage = z.infer<typeof S.TransactionPage>;
export type CategoryMove = z.infer<typeof S.CategoryMove>;
export type PayeeName = z.infer<typeof S.PayeeName>;

export function toCategories(categories: Record<string, [string, string, boolean]>): Category[] {
  return Object.entries(categories).map(([id, [label, icon, spending]]) => ({ id, label, icon, spending }));
}

/** Spending and income per month, oldest first. */
export function toMonthly(byMonth: Map<string, { spent: number; income: number }>): Overview["monthly"] {
  return sorted(byMonth.entries(), ([k]) => k).map(([k, v]) => ({ month: k, spent: pyRound(v.spent, 2), income: pyRound(v.income, 2) }));
}

type OverviewParts = Omit<Overview, "by_category" | "daily" | "merchants"> & { by_category: Row[]; daily: Row[]; merchants: Row[] };

/** The month's overview, with income as summed (unrounded) and the per-category, per-day and per-merchant rows as read. */
export function toOverview(o: OverviewParts): Overview {
  return {
    month: o.month, start: o.start, end: o.end, current: o.current, total: o.total, count: o.count, income: pyRound(o.income, 2),
    prev_month: o.prev_month, prev_total: o.prev_total, prev_to_date: o.prev_to_date,
    by_category: o.by_category.map((r) => ({ category: r.category, amount: r.amount, count: r.count })),
    daily: o.daily.map((r) => ({ date: r.date, amount: r.amount })),
    monthly: o.monthly,
    merchants: o.merchants.map((r) => ({ merchant: r.merchant, category: r.category, amount: r.amount, count: r.count })),
    oldest_month: o.oldest_month,
  };
}

export function toTransaction(r: Row): Transaction {
  return {
    id: r.id, date: r.date, amount: r.amount, currency: r.currency, status: r.status, description: r.description, merchant: r.merchant,
    mcc: r.mcc, category: r.category, commitment_id: r.commitment_id, account_name: r.account_name, is_card: r.is_card,
    booked: r.booked ?? null,
  };
}

export function toTransactionPage(rows: Row[], total: number, spent: number): TransactionPage {
  return { rows: rows.map(toTransaction), total, spent: pyRound(spent, 2) };
}

export function toCategoryMove(rule: string, merchant: string | null | undefined, others: number): CategoryMove {
  return { ok: true, rule, merchant: merchant || null, others };
}

export function toPayeeName(payee: string, merchant: string, payments: number): PayeeName {
  return { ok: true, payee, merchant, payments };
}

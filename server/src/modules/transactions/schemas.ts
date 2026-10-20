/** What the transactions' routes return. */

import { z } from "zod";

export const Category = z.strictObject({ id: z.string(), label: z.string(), icon: z.string(), spending: z.boolean() });

export const Overview = z.strictObject({
  month: z.string(), start: z.string(), end: z.string(), current: z.boolean(), total: z.number(), count: z.number(), income: z.number(),
  prev_month: z.string(), prev_total: z.number(), prev_to_date: z.number(),
  by_category: z.array(z.strictObject({ category: z.string(), amount: z.number(), count: z.number() })),
  daily: z.array(z.strictObject({ date: z.string(), amount: z.number() })),
  monthly: z.array(z.strictObject({ month: z.string(), spent: z.number(), income: z.number() })),
  merchants: z.array(z.strictObject({ merchant: z.string(), category: z.string(), amount: z.number(), count: z.number() })),
  oldest_month: z.string().nullable(),
});

export const Transaction = z.strictObject({
  id: z.string(), date: z.string(), amount: z.number(), currency: z.string(), status: z.string(), description: z.string(),
  merchant: z.string(), mcc: z.string().nullable(), category: z.string(), commitment_id: z.number().nullable(),
  account_name: z.string(), is_card: z.number(),
  booked: z.string().nullable(),  // the day the bank booked it, when that isn't the day you paid
});

/** One page of the list; total and spent cover every match, not just the page. */
export const TransactionPage = z.strictObject({ rows: z.array(Transaction), total: z.number(), spent: z.number() });

/** Where a payment was moved; others: payments to the same payee still in another category. */
export const CategoryMove = z.strictObject({ ok: z.literal(true), rule: z.string(), merchant: z.string().nullable(), others: z.number() });

export const schemas = { Category, Overview, Transaction, TransactionPage, CategoryMove };

export const responses = {
  "GET /api/categories": z.array(Category),
  "GET /api/overview": Overview,
  "GET /api/transactions": TransactionPage,
  "PUT /api/transactions/:txId{.+}/category": CategoryMove,
};

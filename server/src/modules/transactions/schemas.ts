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

/** A payee given your own name. payee: as the bank knows it; merchant: what its payments now show (the bank's again
 * when the name was cleared); payments: how many show under it. */
export const PayeeName = z.strictObject({ ok: z.literal(true), payee: z.string(), merchant: z.string(), payments: z.number() });

/** One payment, for its sheet. pinned: linked to its fixed cost by hand rather than by its payee. costs: the fixed
 * costs it could be linked to. */
export const Payment = z.strictObject({
  id: z.string(), date: z.string(), booked: z.string().nullable(), amount: z.number(), currency: z.string(), status: z.string(),
  category: z.string(), name: z.string(), merchant: z.string(), description: z.string(),
  account: z.strictObject({ name: z.string(), bank: z.string().nullable(), last4: z.string().nullable(), is_card: z.boolean() }),
  commitment_id: z.number().nullable(), commitment: z.string().nullable(), pinned: z.boolean(),
  costs: z.array(z.strictObject({ id: z.number(), name: z.string() })),
});

export const schemas = { Category, Overview, Transaction, TransactionPage, CategoryMove, PayeeName, Payment };

export const responses = {
  "GET /api/categories": z.array(Category),
  "GET /api/overview": Overview,
  "GET /api/transactions": TransactionPage,
  "PUT /api/transactions/:txId{.+}/category": CategoryMove,
  "PUT /api/transactions/:txId{.+}/payee": PayeeName,
  "GET /api/payment": Payment,
  "PUT /api/payment/commitment": Payment,
};

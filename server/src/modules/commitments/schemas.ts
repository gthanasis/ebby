/** What the commitments' routes return. */

import { z } from "zod";

/** A commitment this month: 1 = monthly; 3, 6 or 12 for costs paid every few months, which carry their cycle. */
export const Commitment = z.strictObject({
  id: z.number(), user_id: z.number(), name: z.string(), kind: z.enum(["fixed", "chosen"]), monthly_limit: z.number(), note: z.string(),
  services: z.array(z.string()), off_bank: z.number(), every_months: z.number(), amount: z.number().nullable(),
  next_date: z.string().nullable(), created_at: z.string(), last_date: z.string().optional(), set_aside: z.number().optional(),
  spent: z.number(), count: z.number(), over: z.boolean(), history: z.array(z.strictObject({ month: z.string(), spent: z.number() })),
});

/** A regular payment not covered yet, with a limit to start from. */
export const CommitmentSuggestion = z.strictObject({ service: z.string(), monthly: z.number(), limit: z.number() });

export const Commitments = z.strictObject({
  month: z.string(), items: z.array(Commitment), suggestions: z.array(CommitmentSuggestion),
  limit: z.number(), spent: z.number(), over: z.array(z.string()),
});

/** A fixed cost in one pay month: paid (with the day of its latest payment) or still due (around due_on). */
export const FixedItem = z.strictObject({
  id: z.number(), name: z.string(), kind: z.enum(["fixed", "chosen"]), expected: z.number(), paid: z.number(),
  status: z.enum(["paid", "due"]), paid_on: z.string().nullable(), due_on: z.string().nullable(), count: z.number(),
});

/** A pay month's fixed costs: due first, soonest first, then those paid. due is what's still to go out. */
export const FixedMonth = z.strictObject({ items: z.array(FixedItem), paid: z.number(), due: z.number(), expected: z.number() });

/** A service with spending in the last months, to pick what a commitment covers. */
export const ServiceSeen = z.strictObject({ service: z.string(), monthly: z.number(), months: z.number(), category: z.string() });

export const schemas = { Commitment, CommitmentSuggestion, Commitments, ServiceSeen, FixedItem, FixedMonth };

export const responses = {
  "GET /api/commitments": Commitments,
  "GET /api/commitments/services": z.array(ServiceSeen),
  "POST /api/commitments": Commitments,
  "PUT /api/commitments/:cid": Commitments,
  "DELETE /api/commitments/:cid": Commitments,
  "GET /api/fixed": FixedMonth,
};

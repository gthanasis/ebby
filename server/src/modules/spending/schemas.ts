/** What the spending routes return. */

import { z } from "zod";

import { Explanation, WeeklyRead } from "../assistant/schemas.js";
import { CategoryDetail, Home, Pace, Year } from "../plan/schemas.js";

export const Range = z.enum(["day", "week", "month", "year"]);

export const SpendPayment = z.strictObject({ date: z.string(), amount: z.number(), category: z.string(), name: z.string() });

/** A day of a period; spent is null for days still to come. */
export const SpendDay = z.strictObject({ date: z.string(), spent: z.number().nullable() });

export const Highlight = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("category"), category: z.string(), spent: z.number(), usual: z.number(), count: z.number(), usual_count: z.number().nullable() }),
  z.strictObject({ kind: z.literal("payment"), date: z.string(), amount: z.number(), category: z.string(), name: z.string() }),
  z.strictObject({ kind: z.literal("weekday"), weekday: z.number(), average: z.number(), overall: z.number() }),
  z.strictObject({ kind: z.literal("nospend"), days: z.number(), of: z.number() }),
  z.strictObject({ kind: z.literal("month"), month: z.string(), total: z.number(), usual: z.number(), category: z.string(), amount: z.number() }),
  z.strictObject({ kind: z.literal("trend"), category: z.string(), before: z.number(), after: z.number(), from: z.string(), to: z.string() }),
  z.strictObject({ kind: z.literal("heavy_months"), months: z.array(z.string()), of: z.number() }),
]);

/** Any day, week, pay month or year. Day adds week and usual; week and month the comparison with the periods before;
 * year its months. */
export const SpendView = z.strictObject({
  range: Range, off: z.number(), key: z.string(), start: z.string(), end: z.string(), today: z.string(),
  partial: z.boolean(), elapsed: z.number(), length: z.number(), total: z.number(), count: z.number(), can_prev: z.boolean(), can_next: z.boolean(),
  // The read is kept with the total it explained, so it shows until the period's spending changes.
  ai: z.boolean(), explanation: Explanation.extend({ total: z.number() }).nullable(),
  week: z.array(SpendDay).optional(),
  usual: z.number().nullable().optional(), last: z.number().nullable().optional(), last_key: z.string().optional(),
  usual_full: z.number().nullable().optional(),
  days: z.array(SpendDay).optional(),
  trend: z.array(z.strictObject({ off: z.number(), key: z.string(), start: z.string(), total: z.number() })).optional(),
  months: z.array(z.strictObject({ key: z.string(), total: z.number().nullable(), done: z.boolean() })).optional(),
  categories: z.array(z.strictObject({
    category: z.string(), spent: z.number(), count: z.number(), usual: z.number().optional(), per_month: z.number().optional(),
  })).optional(),
  highlights: z.array(Highlight).optional(),
  payments: z.array(SpendPayment),
});

export const SpendCategory = z.strictObject({
  category: z.string(), range: Range, off: z.number(), key: z.string(), start: z.string(), end: z.string(), month: z.string(),
  total: z.number(), count: z.number(), usual_month: z.number(), history: z.array(z.strictObject({ key: z.string(), total: z.number() })),
  services: z.array(z.strictObject({ name: z.string(), spent: z.number(), count: z.number() })),
});

const MonthSpent = z.strictObject({ month: z.string(), spent: z.number() });

export const ServiceDetail = z.strictObject({
  category: z.string(), name: z.string(), month: z.string(), spent: z.number(), count: z.number(), average: z.number(), share: z.number().nullable(),
  history: z.array(MonthSpent), weekdays: z.array(z.number()), busiest_days: z.array(z.strictObject({ date: z.string(), count: z.number() })),
});

export const Subscription = z.strictObject({
  name: z.string(), monthly: z.number(), months: z.number(), last_charge: z.string(), next_charge: z.string().nullable(),
  varies: z.boolean(), stale: z.boolean(),
});

export const Subscriptions = z.strictObject({ items: z.array(Subscription), monthly: z.number(), yearly: z.number(), count: z.number() });

/** A payee left in Other, for the assistant to ask about. */
export const Question = z.strictObject({
  service: z.string(), tx_id: z.string(), count: z.number(), amount: z.number(), date: z.string(), account: z.string(), has_merchant: z.boolean(),
});

/** Cash withdrawn this month against what was logged. */
export const Cash = z.strictObject({ withdrawn: z.number(), logged: z.number(), unaccounted: z.number() });

export const schemas = {
  Range, SpendPayment, SpendDay, Highlight, SpendView, SpendCategory, ServiceDetail, Subscription, Subscriptions, Question, Cash,
};

export const responses = {
  "GET /api/home": Home,
  "GET /api/spending": SpendView,
  "POST /api/spending/explain": Explanation,
  "GET /api/spending/category": SpendCategory,
  "GET /api/pace": Pace,
  "GET /api/category/:category": CategoryDetail,
  "GET /api/service": ServiceDetail,
  "POST /api/service/move": z.strictObject({ moved: z.number() }),
  "GET /api/subscriptions": Subscriptions,
  "GET /api/year": Year,
  "POST /api/insights/refresh": WeeklyRead,
};

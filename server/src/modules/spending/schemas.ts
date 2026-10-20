/** What the spending routes return. */

import { z } from "zod";

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

/** Claude's read of a period. */
export const Explanation = z.strictObject({ headline: z.string(), points: z.array(z.string()), try: z.string(), created_at: z.string() });

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
const CategorySpent = z.strictObject({ category: z.string(), spent: z.number(), count: z.number() });

/** When pay seems to arrive, read from the deposits. */
export const PaydayGuess = z.strictObject({ day: z.number(), amount: z.number(), last: z.string(), months: z.number() });

/** The budget this month should keep to. */
export const Ideal = z.strictObject({
  income: z.number(), savings: z.number(), fixed: z.number(),
  goals: z.array(z.strictObject({ name: z.string(), price: z.number(), target_date: z.string(), monthly: z.number() })),
  budget: z.number(), day: z.number(), targets: z.record(z.string(), z.number()),
});

/** This pay month so far. days covers the whole month; spent is null for days still to come. */
export const TodayMonth = z.strictObject({
  month: z.string(), start: z.string(), end: z.string(), today: z.string(), length: z.number(), elapsed: z.number(), spent: z.number(),
  days: z.array(SpendDay), average: z.number(), projected: z.number(), categories: z.array(CategorySpent), ideal: Ideal.nullable(),
});

export const Home = z.strictObject({ month: TodayMonth, fresh_at: z.string().nullable(), payday_hint: PaydayGuess.nullable() });

export const PaceCategory = z.strictObject({
  category: z.string(), spent: z.number(), count: z.number(), budget: z.number().nullable(),
  status: z.enum(["over", "ahead", "fine", "none"]), habit: z.string(),
});

export const Pace = z.strictObject({
  month: z.string(), start: z.string(), end: z.string(), elapsed: z.number(), days: z.number(), total: z.number(), planned: z.number().nullable(),
  expected_to_date: z.number().nullable(), projected: z.number(), take_home: z.number().nullable(), categories: z.array(PaceCategory),
});

export const CategoryDetail = z.strictObject({
  category: z.string(), month: z.string(), budget: z.number().nullable(), history: z.array(MonthSpent), spent: z.number(),
  services: z.array(z.strictObject({ name: z.string(), amount: z.number(), count: z.number(), accounts: z.array(z.string()) })),
});

export const ServiceDetail = z.strictObject({
  category: z.string(), name: z.string(), month: z.string(), spent: z.number(), count: z.number(), average: z.number(), share: z.number().nullable(),
  history: z.array(MonthSpent), weekdays: z.array(z.number()), busiest_days: z.array(z.strictObject({ date: z.string(), count: z.number() })),
});

export const Subscription = z.strictObject({
  name: z.string(), monthly: z.number(), months: z.number(), last_charge: z.string(), next_charge: z.string().nullable(),
  varies: z.boolean(), stale: z.boolean(),
});

export const Subscriptions = z.strictObject({ items: z.array(Subscription), monthly: z.number(), yearly: z.number(), count: z.number() });

export const Year = z.strictObject({
  year: z.number(), total: z.number(), months: z.array(MonthSpent), categories: z.array(CategorySpent),
  monthly_average: z.number(), monthly_plan: z.number().nullable(), peak: MonthSpent.nullable(),
  peak_category: z.strictObject({ category: z.string(), spent: z.number() }).nullable(), under_plan: z.array(z.string()),
  committed: z.number(), years: z.array(z.string()),
});

/** This week's read from Claude. */
export const WeeklyRead = z.strictObject({
  headline: z.string(),
  findings: z.array(z.strictObject({ title: z.string(), detail: z.string(), amount: z.number(), unit: z.string(), category: z.string() })),
  actions: z.array(z.strictObject({ text: z.string(), saves_monthly: z.number() })),
  body: z.string(), created_at: z.string(), model: z.string(), budgets: z.record(z.string(), z.number()).nullable(),
});

/** A payee left in Other, for the assistant to ask about. */
export const Question = z.strictObject({
  service: z.string(), tx_id: z.string(), count: z.number(), amount: z.number(), date: z.string(), account: z.string(), has_merchant: z.boolean(),
});

/** Cash withdrawn this month against what was logged. */
export const Cash = z.strictObject({ withdrawn: z.number(), logged: z.number(), unaccounted: z.number() });

export const schemas = {
  Range, SpendPayment, SpendDay, Highlight, Explanation, SpendView, SpendCategory, PaydayGuess, Ideal, TodayMonth, Home,
  PaceCategory, Pace, CategoryDetail, ServiceDetail, Subscription, Subscriptions, Year, WeeklyRead, Question, Cash,
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

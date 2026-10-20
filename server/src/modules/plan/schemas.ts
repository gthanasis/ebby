/** What the plan's routes return, and the plan-built views other features serve (pace, today, a category, the year). */

import { z } from "zod";

export const ExtraPay = z.strictObject({ name: z.string(), amount: z.number(), date: z.string(), when: z.string() });

/** Plans from before the split was kept may lack split and limits. */
export const Plan = z.strictObject({
  take_home: z.number(), keep: z.number(), split: z.enum(["auto", "custom"]).optional(),
  budgets: z.record(z.string(), z.number()), limits: z.record(z.string(), z.number()).optional(),
});

/** The settings document with its defaults: account's, declared here for now. */
export const Settings = z.strictObject({
  alerts: z.boolean(), weekly_read: z.boolean(), assistant_model: z.enum(["haiku", "sonnet", "opus"]),
  work_hours: z.number().optional(), payday: z.union([z.number(), z.literal("last")]).optional(),
  payday_dismissed: z.boolean().optional(), autofill_dismissed: z.boolean().optional(), autofilled: z.boolean().optional(),
  extra_pay: z.boolean().optional(), owner_names: z.array(z.string()).optional(),
});

/** When pay seems to arrive, read from the deposits. */
export const PaydayGuess = z.strictObject({ day: z.number(), amount: z.number(), last: z.string(), months: z.number() });

export const PlanView = z.strictObject({
  plan: Plan.nullable(), averages: z.record(z.string(), z.number()), total: z.number().optional(), committed: z.number(),
  settings: Settings, devices: z.number(), ai: z.boolean(), payday_detected: PaydayGuess.nullable(), extra_pay: z.array(ExtraPay),
});

export const PlanSuggestion = z.strictObject({
  budgets: z.record(z.string(), z.number()), averages: z.record(z.string(), z.number()), committed: z.number(),
});

export const PaceCategory = z.strictObject({
  category: z.string(), spent: z.number(), count: z.number(), budget: z.number().nullable(),
  status: z.enum(["over", "ahead", "fine", "none"]), habit: z.string(),
});

export const Pace = z.strictObject({
  month: z.string(), start: z.string(), end: z.string(), elapsed: z.number(), days: z.number(), total: z.number(),
  planned: z.number().nullable(), expected_to_date: z.number().nullable(), projected: z.number(), take_home: z.number().nullable(),
  categories: z.array(PaceCategory),
});

export const Ideal = z.strictObject({
  income: z.number(), savings: z.number(), fixed: z.number(),
  goals: z.array(z.strictObject({ name: z.string(), price: z.number(), target_date: z.string(), monthly: z.number() })),
  budget: z.number(), day: z.number(), targets: z.record(z.string(), z.number()),
});

/** This pay month so far. days covers the whole month; spent is null for days still to come. */
export const TodayMonth = z.strictObject({
  month: z.string(), start: z.string(), end: z.string(), today: z.string(), length: z.number(), elapsed: z.number(), spent: z.number(),
  days: z.array(z.strictObject({ date: z.string(), spent: z.number().nullable() })),
  average: z.number(), projected: z.number(),
  categories: z.array(z.strictObject({ category: z.string(), spent: z.number(), count: z.number() })),
  ideal: Ideal.nullable(),
});

export const Home = z.strictObject({ month: TodayMonth, fresh_at: z.string().nullable(), payday_hint: PaydayGuess.nullable() });

export const CategoryDetail = z.strictObject({
  category: z.string(), month: z.string(), budget: z.number().nullable(),
  history: z.array(z.strictObject({ month: z.string(), spent: z.number() })),
  spent: z.number(),
  services: z.array(z.strictObject({ name: z.string(), amount: z.number(), count: z.number(), accounts: z.array(z.string()) })),
});

const MonthSpent = z.strictObject({ month: z.string(), spent: z.number() });

export const Year = z.strictObject({
  year: z.number(), total: z.number(), months: z.array(MonthSpent),
  categories: z.array(z.strictObject({ category: z.string(), spent: z.number(), count: z.number() })),
  monthly_average: z.number(), monthly_plan: z.number().nullable(), peak: MonthSpent.nullable(),
  peak_category: z.strictObject({ category: z.string(), spent: z.number() }).nullable(), under_plan: z.array(z.string()),
  committed: z.number(), years: z.array(z.string()),
});

export const schemas = {
  ExtraPay, Plan, Settings, PaydayGuess, PlanView, PlanSuggestion, PaceCategory, Pace, Ideal, TodayMonth, Home, CategoryDetail, Year,
};

export const responses = {
  "GET /api/plan": PlanView,
  "POST /api/plan/suggest": PlanSuggestion,
  "PUT /api/plan": Plan,
  "PUT /api/plan/limit": Plan,
  "PUT /api/settings": Settings,
};

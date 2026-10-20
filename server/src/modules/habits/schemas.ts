/** What the habits' routes return. */

import { z } from "zod";

export const SavingsAccount = z.strictObject({ id: z.string(), bank: z.string(), name: z.string(), is_card: z.number(), selected: z.boolean() });

/** Pay yourself first: since payday, has what you plan to keep reached your savings accounts? */
export const PayFirst = z.strictObject({
  target: z.number().nullable(), saved: z.number(), since: z.string(),
  payday: z.strictObject({ date: z.string(), amount: z.number() }).nullable(),
  accounts: z.array(SavingsAccount),
});

/** This week's days, null for those still to come, and how many had no free spending. */
export const NoSpend = z.strictObject({
  week: z.array(z.strictObject({ date: z.string(), spent: z.number().nullable() })),
  count_week: z.number(), days_done: z.number(), best_month: z.number(),
});

/** Something on the 48-hour list, not decided on yet. */
export const Wish = z.strictObject({
  id: z.number(), user_id: z.number(), name: z.string(), price: z.number(), created_at: z.string(),
  decided_at: z.string().nullable(), decision: z.string().nullable(), reminded: z.number(),
  ready_at: z.string(), ready: z.boolean(), hours_of_work: z.number().nullable(),
});

export const YearlyCost = z.strictObject({
  id: z.number(), user_id: z.number(), name: z.string(), yearly_amount: z.number(), due_month: z.number(), created_at: z.string(),
  monthly: z.number(), next_due: z.string(), months_left: z.number(),
});

/** A charge that came once a year, offered as a yearly cost. */
export const YearlySuggestion = z.strictObject({ name: z.string(), yearly_amount: z.number(), due_month: z.number(), last_paid: z.string() });

export const Yearly = z.strictObject({ items: z.array(YearlyCost), monthly: z.number(), suggestions: z.array(YearlySuggestion) });

export const Habits = z.strictObject({
  pay_first: PayFirst, no_spend: NoSpend, wishlist: z.array(Wish), skipped_year: z.number(), hourly_rate: z.number().nullable(),
  yearly: Yearly,
});

export const HabitType = z.enum(["fewer", "spend_less", "nospend", "wait"]);
export const HabitStatus = z.enum(["on_track", "at_risk", "missed", "kept"]);

export const Habit = z.strictObject({
  id: z.number(), user_id: z.number(), type: HabitType, category: z.string().nullable(), target: z.number(), baseline: z.number(),
  goal_id: z.number().nullable(), created_at: z.string(),
  title: z.string(), value: z.number(), status: HabitStatus, streak: z.number(), saved: z.number(), days_left: z.number(), nudge: z.string(),
});

/** One week of a habit: its number, what was spent (for the money habits), and whether it was kept. */
export const HabitWeek = z.strictObject({
  start: z.string(), value: z.number(), spent: z.number().nullable(), status: HabitStatus, counted: z.boolean(), current: z.boolean(),
});

export const HabitDetail = Habit.extend({
  weeks: z.array(HabitWeek),
  days: z.array(z.strictObject({ date: z.string(), value: z.number().nullable() })),
  goal: z.strictObject({ id: z.number(), name: z.string() }).nullable(),
});

/** A habit worth starting, with why and what it would save a month (null when it's not about money). */
export const HabitSuggestion = z.strictObject({
  type: HabitType, category: z.string().nullable(), target: z.number(), why: z.string(), monthly: z.number().nullable(), title: z.string(),
});

export const HabitsWeek = z.strictObject({
  week: z.strictObject({ start: z.string(), end: z.string(), days_left: z.number() }),
  habits: z.array(Habit), on_track: z.number(), total: z.number(),
  nudge: z.strictObject({ status: HabitStatus, title: z.string(), text: z.string() }).nullable(),
  saved: z.number(), suggestions: z.array(HabitSuggestion),
});

export const schemas = {
  SavingsAccount, PayFirst, NoSpend, Wish, YearlyCost, YearlySuggestion, Yearly, Habits,
  HabitType, HabitStatus, Habit, HabitWeek, HabitDetail, HabitSuggestion, HabitsWeek,
};

export const responses = {
  "GET /api/habits": Habits,
  "GET /api/habits/weekly": HabitsWeek,
  "POST /api/habits/rules": HabitsWeek.extend({ id: z.number() }),
  "GET /api/habits/rules/:hid": HabitDetail,
  "PATCH /api/habits/rules/:hid": HabitDetail,
  "DELETE /api/habits/rules/:hid": HabitsWeek,
  "PUT /api/habits/savings-accounts": Habits,
  "POST /api/wishlist": Habits,
  "POST /api/wishlist/:wid/decide": Habits,
  "POST /api/yearly": Habits,
  "DELETE /api/yearly/:yid": Habits,
};

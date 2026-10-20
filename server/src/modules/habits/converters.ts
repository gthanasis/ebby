/** Habits, wishes and yearly costs as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import { isoUtc, PyDate, pyRound } from "../../shared/utils/python.js";
import type { HabitRule, Wish as WishRow, YearlyCost as YearlyCostRow } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type Wish = z.infer<typeof S.Wish>;
export type YearlyCost = z.infer<typeof S.YearlyCost>;
export type HabitType = z.infer<typeof S.HabitType>;
export type HabitStatus = z.infer<typeof S.HabitStatus>;
export type HabitWeek = z.infer<typeof S.HabitWeek>;
export type Habit = z.infer<typeof S.Habit>;
export type HabitDetail = z.infer<typeof S.HabitDetail>;

/** A wish with when its 48 hours are up, and what it costs in hours of work (when there's an hourly rate). */
export function toWish(r: WishRow, readyAt: Date, at: Date, rate: number | null): Wish {
  return { ...r, ready_at: isoUtc(readyAt, "seconds"), ready: at.getTime() >= readyAt.getTime(), hours_of_work: rate ? pyRound(r.price / rate, 1) : null };
}

/** A yearly cost with its monthly share and its next due month, from today. */
export function toYearlyCost(y: YearlyCostRow, today: PyDate): YearlyCost {
  const due = new PyDate(today.year + (y.due_month < today.month ? 1 : 0), y.due_month, 1);
  const monthsLeft = (due.year - today.year) * 12 + due.month - today.month;
  return { ...y, monthly: pyRound(y.yearly_amount / 12, 2), next_due: due.isoformat().slice(0, 7), months_left: monthsLeft };
}

/** A habit and how this week is going. */
export function toHabit(r: HabitRule, title: string, current: HabitWeek, streak: number, saved: number, daysLeft: number, nudge: string): Habit {
  return {
    ...r, type: r.type as HabitType, title, value: current.value, status: current.status, streak,
    saved: pyRound(saved, 2), days_left: daysLeft, nudge,
  };
}

export function toHabitDetail(habit: Habit, weeks: HabitWeek[], days: HabitDetail["days"], goal: HabitDetail["goal"]): HabitDetail {
  return { ...habit, weeks, days, goal };
}

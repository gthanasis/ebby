/** Goals as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import { PyDate, pyRound } from "../../shared/utils/python.js";
import type { Goal as GoalRow } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type Goal = z.infer<typeof S.Goal>;
export type Cut = z.infer<typeof S.Cut>;
export type GoalSuggestion = z.infer<typeof S.GoalSuggestion>;

/** What's left to save and what that takes a week and a month, by the target date. */
export function needs(goal: GoalRow, today: PyDate) {
  const remaining = Math.max(0.0, goal.price - goal.saved);
  const days = Math.max(1, PyDate.fromisoformat(goal.target_date).diffDays(today));
  return { remaining, days, weekly: remaining / (days / 7), monthly: remaining / (days / 30.44) };
}

export function toGoal(goal: GoalRow, n: ReturnType<typeof needs>, cuts: Cut[]): Goal {
  const { user_id: _, ...shown } = goal;  // whose it is goes without saying
  return {
    ...shown, kind: goal.kind === "save" ? "save" : "buy", remaining: pyRound(n.remaining, 2), weeks_left: Math.max(1, pyRound(n.days / 7)),
    weekly: pyRound(n.weekly, 2), monthly: pyRound(n.monthly, 2), cuts,
  };
}

/** The safety net: three months of costs, rounded up to the hundred, saved over a year. */
export function toSafetyNet(monthlyCosts: number, targetDate: PyDate): GoalSuggestion {
  const amount = -Math.floor(-monthlyCosts * 3 / 100) * 100;
  return { name: "Safety net", price: amount, kind: "save", target_date: targetDate.isoformat(), monthly: pyRound(amount / 12, 2) };
}

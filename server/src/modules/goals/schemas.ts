/** What the goals' routes return. */

import { z } from "zod";

import { PayFirst } from "../habits/schemas.js";
import { ExtraPay } from "../plan/schemas.js";

/** A change from the last three months that would free up money for a goal. */
export const Cut = z.strictObject({ category: z.string(), text: z.string(), detail: z.string(), monthly: z.number() });

export const Goal = z.strictObject({
  id: z.number(), name: z.string(), price: z.number(), saved: z.number(), target_date: z.string(),
  created_at: z.string(), kind: z.enum(["buy", "save"]),
  remaining: z.number(), weeks_left: z.number(), weekly: z.number(), monthly: z.number(), cuts: z.array(Cut),
});

/** The safety net, offered until there's a savings total. */
export const GoalSuggestion = z.strictObject({ name: z.string(), price: z.number(), kind: z.literal("save"), target_date: z.string(), monthly: z.number() });

export const GoalsOverview = z.strictObject({
  save_monthly: PayFirst.nullable(), goals: z.array(Goal), monthly: z.number(), committed: z.number(),
  take_home: z.number().nullable(), left: z.number().nullable(), suggestion: GoalSuggestion.nullable(), extra_pay: z.array(ExtraPay),
});

export const schemas = { Cut, Goal, GoalSuggestion, GoalsOverview };

export const responses = {
  "GET /api/goals": z.array(Goal),
  "POST /api/goals": z.array(Goal),
  "PATCH /api/goals/:goalId": z.array(Goal),
  "DELETE /api/goals/:goalId": z.array(Goal),
  "GET /api/goals/overview": GoalsOverview,
};

/**
 * The API's response shapes, gathered from each feature's schemas.ts: the read tests hold every snapshot to them,
 * and `npm run api:types` turns them into web/src/lib/api.gen.ts, so the app's types come from the server's.
 */

import type { z } from "zod";

import * as account from "./modules/account/schemas.js";
import * as alerts from "./modules/alerts/schemas.js";
import * as assistant from "./modules/assistant/schemas.js";
import * as banks from "./modules/banks/schemas.js";
import * as commitments from "./modules/commitments/schemas.js";
import * as goals from "./modules/goals/schemas.js";
import * as habits from "./modules/habits/schemas.js";
import * as plan from "./modules/plan/schemas.js";

const features = [goals, plan, banks, account, alerts, commitments, habits, assistant];

/** Merges each feature's entries; two features naming the same shape or route is a mistake, not an override. */
function gather(part: "schemas" | "responses"): Record<string, z.ZodType> {
  const out: Record<string, z.ZodType> = {};
  for (const f of features) {
    for (const [k, v] of Object.entries(f[part] as Record<string, z.ZodType>)) {
      if (k in out) throw new Error(`${part}: ${k} is declared by two features`);
      out[k] = v;
    }
  }
  return out;
}

/** Every named shape, for the web app's types. */
export const schemas = gather("schemas");

/** What each route returns, keyed "METHOD /path" as the router knows it. */
export const responses = gather("responses");

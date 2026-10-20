/**
 * The API's response shapes, gathered from each feature's schemas.ts: the read tests hold every snapshot to them,
 * and `npm run api:types` turns them into web/src/lib/api.gen.ts, so the app's types come from the server's.
 */

import type { z } from "zod";

import * as goals from "./modules/goals/schemas.js";
import * as plan from "./modules/plan/schemas.js";

const features = [goals, plan];

/** Every named shape, for the web app's types. */
export const schemas: Record<string, z.ZodType> = Object.assign({}, ...features.map((f) => f.schemas));

/** What each route returns, keyed "METHOD /path" as the router knows it. */
export const responses: Record<string, z.ZodType> = Object.assign({}, ...features.map((f) => f.responses));

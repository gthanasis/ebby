/** What the plan's routes return. */

import { z } from "zod";

export const ExtraPay = z.strictObject({ name: z.string(), amount: z.number(), date: z.string(), when: z.string() });

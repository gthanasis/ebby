/** What the habits' routes return. */

import { z } from "zod";

export const SavingsAccount = z.strictObject({ id: z.string(), bank: z.string(), name: z.string(), is_card: z.number(), selected: z.boolean() });

/** Pay yourself first: since payday, has what you plan to keep reached your savings accounts? */
export const PayFirst = z.strictObject({
  target: z.number().nullable(), saved: z.number(), since: z.string(),
  payday: z.strictObject({ date: z.string(), amount: z.number() }).nullable(),
  accounts: z.array(SavingsAccount),
});

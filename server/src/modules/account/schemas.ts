/** What the account's routes return: you, your keys, first-run setup, and the admin's people. */

import { z } from "zod";

import { BankAccess, Credentials } from "../banks/schemas.js";

export const Onboarding = z.strictObject({ bank_access: z.boolean(), banks_connected: z.number(), done: z.boolean() });

export const Me = z.strictObject({
  email: z.string(), name: z.string().nullable(), picture: z.string().nullable(), is_admin: z.boolean(),
  ai_budget_usd: z.number(), ai_spent_usd: z.number(), credentials: Credentials, onboarding: Onboarding,
  eb_redirect_url: z.string(),
});

/** What saving an Anthropic key shows of it. */
export const SavedAnthropicKey = z.strictObject({ masked: z.string() });

export const PersonStatus = z.enum(["invited", "active", "disabled"]);

export const Person = z.strictObject({
  id: z.number(), email: z.string(), name: z.string().nullable(), picture: z.string().nullable(), is_admin: z.boolean(),
  status: PersonStatus, ai_budget_usd: z.number(), created_at: z.string(), last_login_at: z.string().nullable(), ai_spent_usd: z.number(),
});

/** Someone just added to the list: their row, without the dates or what they've spent. */
export const InvitedPerson = z.strictObject({
  id: z.number(), email: z.string(), name: z.string().nullable(), picture: z.string().nullable(), is_admin: z.boolean(),
  status: PersonStatus, ai_budget_usd: z.number(),
});

export const schemas = { Onboarding, Me, SavedAnthropicKey, PersonStatus, Person, InvitedPerson };

export const responses = {
  "GET /api/me": Me,
  "POST /api/credentials/enable-banking": BankAccess,
  "POST /api/credentials/anthropic": SavedAnthropicKey,
  "DELETE /api/credentials/:kind": z.null(),
  "POST /api/onboarding/done": z.null(),
  "GET /api/people": z.array(Person),
  "POST /api/people": InvitedPerson,
  "PATCH /api/people/:userId": z.array(Person),
};

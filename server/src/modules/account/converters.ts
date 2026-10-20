/** You and the admin's people as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import { pyRound } from "../../shared/utils/python.js";
import type { User } from "../../types/entities.js";
import type { Credentials } from "../banks/converters.js";
import type * as S from "./schemas.js";

export type Onboarding = z.infer<typeof S.Onboarding>;
export type Me = z.infer<typeof S.Me>;
export type Person = z.infer<typeof S.Person>;

export function toOnboarding(keys: Credentials, banksConnected: number, onboarded: unknown): Onboarding {
  return { bank_access: "enable_banking" in keys, banks_connected: banksConnected, done: Boolean(onboarded) };
}

/** spent: this month's calls on the owner's key; redirectUrl: what to allow on their own Enable Banking app. */
export function toMe(person: Pick<User, "email" | "name" | "picture" | "is_admin" | "ai_budget_usd">, spent: number, keys: Credentials,
  onboarding: Onboarding, redirectUrl: string): Me {
  return {
    email: person.email, name: person.name, picture: person.picture, is_admin: person.is_admin,
    ai_budget_usd: person.ai_budget_usd, ai_spent_usd: pyRound(spent, 2), credentials: keys, onboarding,
    eb_redirect_url: redirectUrl,
  };
}

export function toPerson(r: User & { ai_spent_usd: number }): Person {
  return {
    id: r.id, email: r.email, name: r.name, picture: r.picture, is_admin: r.is_admin, status: r.status as Person["status"],
    ai_budget_usd: r.ai_budget_usd, created_at: r.created_at, last_login_at: r.last_login_at, ai_spent_usd: r.ai_spent_usd,
  };
}

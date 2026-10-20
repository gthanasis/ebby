/**
 * What ebby's data looks like once read: one type per table (from the generated schema in db.ts, as db.ts parses
 * it), and the JSON documents kept in the meta table.
 */

import type { Selectable } from "kysely";

import type * as T from "./db.js";

// ---------- rows, as read ----------

export type Account = Selectable<T.Accounts>;
export type Transaction = Selectable<T.Transactions>;
export type Rule = Selectable<T.Rules>;
export type Goal = Selectable<T.Goals>;
export type HabitRule = Selectable<T.HabitRules>;
export type Wish = Selectable<T.Wishlist>;
export type YearlyCost = Selectable<T.YearlyCosts>;
export type User = Selectable<T.Users>;
export type AssistantAction = Selectable<T.AssistantActions>;

/** A commitment with its services list parsed, and its cycle filled in when it's paid every few months. */
export type Commitment = Omit<Selectable<T.Commitments>, "services"> & {
  services: string[];
  last_date?: string;
  set_aside?: number;
};

/** What went wrong on a bank's last sync; reconnect means its session has to be renewed by the person. */
export interface SyncError { at?: string; code?: string; message: string; reconnect: boolean }

/** A bank connection with its last error parsed. */
export type Connection = Omit<Selectable<T.Connections>, "last_error"> & { last_error: SyncError | null };

// ---------- the documents kept in meta ----------

/** Payday 1 is the calendar month; "last" the last working day; anything else the day of the month pay arrives. */
export type Payday = number | "last";

export interface Plan {
  take_home: number;
  keep: number;
  /** "auto" follows income, savings and fixed costs; "custom" keeps what was typed. */
  split: "auto" | "custom";
  /** Monthly budget per spending category. */
  budgets: Record<string, number>;
  /** A working limit for a pay month (YYYY-MM) on the way down to the plan. */
  limits: Record<string, number>;
}

export interface Settings {
  alerts?: boolean;
  weekly_read?: boolean;
  work_hours?: number;
  payday?: Payday;
  payday_dismissed?: boolean;
  autofill_dismissed?: boolean;
  /** Set when the plan was filled in from the first import. */
  autofilled?: boolean;
  assistant_model?: "haiku" | "sonnet" | "opus";
  /** 14 salaries a year: Easter, summer and Christmas bonuses. */
  extra_pay?: boolean;
  /** Your names as banks print them: transfers to these are your own. */
  owner_names?: string[];
}

export interface WeeklyRead {
  headline: string;
  findings: { title: string; detail: string; amount: number; unit: string; category: string }[];
  actions: { text: string; saves_monthly: number }[];
  body: string;
  created_at: string;
  model: string;
  budgets: Record<string, number> | null;
}

export interface SorterGuess { category: string; reason: string; at: string }

/** Every key meta holds, and what's stored under it (explain:<range>:<start> keys hold an Explanation). */
export interface MetaDocuments {
  settings: Settings;
  plan: Plan;
  weekly_read: WeeklyRead;
  onboarded: boolean;
  /** When the last scheduled and live syncs started. */
  last_attempt: string;
  last_live_sync: string;
  /** The categories.VERSION this person's history was last sorted with. */
  categories_version: number;
  /** Accounts chosen as savings; unset means the ones named like savings. */
  savings_accounts: string[];
  assistant_conversation: number;
  /** Claude's guess per payee in the sorter, made once. */
  sorter_guesses: Record<string, SorterGuess>;
  /** Cool-down alerts sent: pay month → category → level reached. */
  alerts_sent: Record<string, Record<string, number>>;
  /** Commitment alerts sent: pay month → commitment ids. */
  commitment_alerts: Record<string, number[]>;
}
export type MetaKey = keyof MetaDocuments;

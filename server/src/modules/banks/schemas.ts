/** What the banks' routes return: status, the bank list, connecting, syncing; and the keys as anyone may see them. */

import { z } from "zod";

export const Account = z.strictObject({
  id: z.string(), bank: z.string().nullable(), name: z.string(), is_card: z.number(), last4: z.string().nullable(),
  balance: z.number().nullable(), balance_at: z.string().nullable(), synced_at: z.string().nullable(), transactions: z.number(),
  since: z.string().nullable(),
});

/** Why a connection's last sync failed. Removing the bank keys marks every connection with only a message. */
export const SyncError = z.strictObject({ at: z.string().optional(), code: z.string().optional(), message: z.string(), reconnect: z.boolean() });

export const Connection = z.strictObject({
  bank: z.string(), connected: z.boolean(), valid_until: z.string().nullable(), last_sync: z.string().nullable(), last_error: SyncError.nullable(),
});

export const Status = z.strictObject({
  connections: z.array(Connection), last_sync: z.string().nullable(), syncing: z.boolean(), sync_hours: z.number(),
  callback_in_app: z.boolean(), questions: z.number(), month: z.string(), accounts: z.array(Account),
});

/** A bank Enable Banking connects; consent_days is the longest access it allows. */
export const Bank = z.strictObject({ name: z.string(), logo: z.string().nullable(), beta: z.boolean(), consent_days: z.number().nullable() });
export const BankList = z.strictObject({ country: z.string(), banks: z.array(Bank) });

export const SyncStarted = z.strictObject({ started: z.boolean() });
export const LiveSync = z.strictObject({ started: z.boolean(), reason: z.string().optional() });
export const AuthStart = z.strictObject({ url: z.string() });
export const AuthComplete = z.strictObject({ bank: z.string(), accounts: z.number() });

/** The Enable Banking app's public half: never the key itself. */
export const BankAccess = z.strictObject({ app_id: z.string(), key_fingerprint: z.string(), verified_at: z.string().nullable() });
export const AnthropicKey = z.strictObject({ masked: z.string(), verified_at: z.string().nullable() });
/** Each key a person has given, as anyone may see it. */
export const Credentials = z.strictObject({ enable_banking: BankAccess.optional(), anthropic: AnthropicKey.optional() });

export const schemas = {
  Account, SyncError, Connection, Status, Bank, BankList, SyncStarted, LiveSync, AuthStart, AuthComplete, BankAccess, AnthropicKey, Credentials,
};

export const responses = {
  "GET /api/status": Status,
  "POST /api/sync": SyncStarted,
  "GET /api/banks": BankList,
  "POST /api/auth/start": AuthStart,
  "POST /api/auth/complete": AuthComplete,
  "POST /api/sync/live": LiveSync,
};

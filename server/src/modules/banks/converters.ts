/** Accounts, connections and keys as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import type { Account as AccountRow, Connection as ConnectionRow } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type Account = z.infer<typeof S.Account>;
export type Connection = z.infer<typeof S.Connection>;
export type Credentials = z.infer<typeof S.Credentials>;

/** An account with how many transactions it has and the date of its first. */
export type AccountWithCounts = Omit<AccountRow, "uid" | "user_id"> & { transactions: number; since: string | null };

export function toAccount(a: AccountWithCounts): Account {
  return {
    id: a.id, bank: a.bank, name: a.name, is_card: a.is_card, last4: a.last4, balance: a.balance, balance_at: a.balance_at,
    synced_at: a.synced_at, transactions: a.transactions, since: a.since,
  };
}

export function toConnection(x: ConnectionRow): Connection {
  return { bank: x.bank, connected: Boolean(x.session_id), valid_until: x.valid_until, last_sync: x.last_sync, last_error: x.last_error };
}

/** What's safe to show of each key: {kind: public_info + verified_at}. */
export function toCredentials(rows: { kind: string; public_info: any; verified_at: string | null }[]): Credentials {
  return Object.fromEntries(rows.map((r) => [r.kind, { ...r.public_info, verified_at: r.verified_at ?? null }]));
}

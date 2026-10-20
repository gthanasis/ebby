/** Getting each person's transactions from their banks: on connecting, on opening the app, and on a schedule. */

import { randomUUID } from "node:crypto";

import * as clock from "../clock.js";
import { config } from "../config.js";
import * as credentials from "../integrations/credentials.js";
import * as db from "../data/db.js";
import type { Row } from "../data/db.js";
import * as accountsRepo from "../data/repos/accounts.js";
import * as connectionsRepo from "../data/repos/connections.js";
import * as ai from "../domain/ai.js";
import * as aiUsage from "../domain/ai_usage.js";
import * as alerts from "../domain/alerts.js";
import * as categories from "../core/categories.js";
import * as banks from "../integrations/banks.js";
import * as push from "../integrations/push.js";
import { type Client, EnableBankingError, MAX_HISTORY_DAYS, type Psu } from "../integrations/enable_banking.js";
import { isoUtc, parseIso } from "../py.js";
import { assignCommitments } from "../domain/commitments.js";
import { autofill } from "../domain/plan.js";
import { withPayCalendar } from "../domain/months.js";
import * as ingest from "../domain/ingest.js";

export const nowIso = () => isoUtc(clock.now(), "seconds");

export const isSyncing = () => db.isLocked(db.LOCK_SYNC, db.currentUser()!);

/** Runs fn in the background, still acting for the current person; failures are logged, not thrown. */
export function background(fn: () => Promise<unknown>) {
  const user = db.currentUser();
  const run = user == null ? fn : () => db.asUser(user, fn);
  void Promise.resolve().then(run).catch((e) => console.error("background work failed:", e));
}

export async function startAuth(bank: string): Promise<string> {
  if (config.DEMO) throw new Error("This is the demo: banks can't be connected here.");
  const info = await banks.find(bank);
  if (!info) throw new Error(`${bank} isn't a bank Enable Banking connects in ${config.COUNTRY}.`);
  const state = randomUUID();
  const url = await (await credentials.client()).startAuth(bank, state, Math.min(config.CONSENT_DAYS, info.consent_days || config.CONSENT_DAYS));
  await db.connect((conn) => db.updateConnection(conn, bank, { auth_state: state }));
  return url;
}

/** Finishes authorisation from the address the bank redirected to. Returns [bank, account count]. */
export async function completeAuth(address: string): Promise<[string, number]> {
  let query: URLSearchParams;
  try { query = new URL(address.trim()).searchParams; } catch { query = new URLSearchParams(); }
  const state = query.get("state");
  const row = state ? await db.connect((conn) => connectionsRepo.byAuthState(conn, state)) : null;
  if (!row) throw new Error("That address isn't from the latest connection attempt. Start again.");
  if (!query.has("code")) throw new Error(`The bank didn't return a code (${query.get("error") ?? "no details"}).`);
  const bank = row.bank;
  const session = await (await credentials.client()).createSession(query.get("code")!);
  await db.connect(async (conn) => {
    for (const acc of session.accounts ?? []) await ingest.upsertAccount(conn, acc, bank);
    // Full history is usually only served in the first hour after authorising, so backfill now.
    await db.updateConnection(conn, bank, {
      session_id: session.session_id, valid_until: session.access?.valid_until ?? null, auth_state: null, last_error: null, backfill: 1,
    });
  });
  background(() => sync());
  return [bank, (session.accounts ?? []).length];
}

export const LIVE_LOOKBACK_DAYS = 7;

/** Syncs every connected bank that doesn't need reconnecting. True if all of them succeeded. psu: the user's own
 * request headers when they opened the app (a live sync); null for the schedule. */
export async function sync(psu: Psu = null): Promise<boolean> {
  // One sync at a time per person, across every pod; different people's banks sync independently.
  return db.advisoryLock(db.LOCK_SYNC, db.currentUser()!, (mine) => (mine ? syncAll(psu) : Promise.resolve(false)));
}

export async function syncAll(psu: Psu): Promise<boolean> {
  const todo = await db.connect(async (conn) => {
    await db.setMeta(conn, psu ? "last_live_sync" : "last_attempt", nowIso());
    return (await db.connections(conn)).filter((c) => c.session_id && !(c.last_error || {}).reconnect);
  });
  if (!todo.length) return true;
  const client = await credentials.client();
  const results = [];
  for (const c of todo) results.push(await syncBank(client, c, psu));
  return results.every(Boolean);
}

export async function syncBank(client: Client, connRow: Row, psu: Psu = null): Promise<boolean> {
  const bank = connRow.bank;
  let error: Row;
  try {
    const accounts = await db.connect((conn) => accountsRepo.syncable(conn, bank));
    const days = connRow.backfill || !connRow.last_sync ? MAX_HISTORY_DAYS : psu ? LIVE_LOOKBACK_DAYS : config.SYNC_LOOKBACK_DAYS;
    let changed = 0;
    for (const acc of accounts) {
      for await (const [start, end, rows] of client.transactions(acc.uid, days, psu)) {
        changed += await db.connect((conn) => ingest.saveWindow(conn, acc.id, Boolean(acc.is_card), start.isoformat(), end.isoformat(), rows));
      }
      const balance = pickBalance(await client.balances(acc.uid, psu));
      await db.connect((conn) => accountsRepo.setBalance(conn, acc.id, balance, nowIso(), nowIso()));
    }
    const pairs = await db.connect(async (conn) => {
      const made = await ingest.dedupe(conn);
      await assignCommitments(conn);  // new rows from this sync
      await autofill(conn);  // first import: set the plan up from the transactions
      await db.updateConnection(conn, bank, { last_sync: nowIso(), last_error: null, backfill: 0 });
      return made;
    });
    if (pairs) console.info(`${bank}: ${pairs} debit-card purchases paired with their account rows`);
    console.info(`${bank}: sync done, ${changed} rows changed across ${accounts.length} accounts`);
    return true;
  } catch (e) {
    if (e instanceof EnableBankingError) {
      console.warn(`${bank}: sync failed: ${e}`);
      error = { at: nowIso(), code: e.code, message: e.message, reconnect: e.sessionExpired };
    } else {  // keep the scheduler alive on network hiccups
      console.error(`${bank}: sync failed`, e);
      const err = e as Error;
      error = { at: nowIso(), code: err?.constructor?.name ?? "Error", message: String(err?.message ?? e), reconnect: false };
    }
  }
  await db.connect((conn) => db.updateConnection(conn, bank, { last_error: error }));
  return false;
}

export function pickBalance(balances: Row[]): number | null {
  const order = ["ITAV", "CLAV", "ITBD", "CLBD", "XPCD", "OTHR"];
  const rank = (b: Row) => (order.includes(b.balance_type) ? order.indexOf(b.balance_type) : 99);
  for (const b of [...balances].sort((a, z) => rank(a) - rank(z))) {
    const amount = b.balance_amount?.amount;
    if (amount != null) return parseFloat(amount);
  }
  return null;
}

/** Mondays from 09:00 local time, once per ISO week. */
async function weeklyReadDue(): Promise<boolean> {
  const now = clock.localNow();
  if (!(await ai.available()) || now.weekday !== 0 || now.hour < 9) return false;
  return db.connect(async (conn) => {
    const read = await db.getMeta(conn, "weekly_read");
    const settings = (await db.getMeta(conn, "settings")) || {};
    if (!(settings.weekly_read ?? true)) return false;
    if (!read?.created_at) return true;
    // The week it was made in, as stored (UTC), like the Python app.
    const [y, w] = clock.wallClock(parseIso(read.created_at), "UTC").date.isocalendar();
    const [ny, nw] = now.date.isocalendar();
    return y !== ny || w !== nw;
  });
}

let started = false;

/** Background loop, for each active person: sync every SYNC_HOURS (banks allow about 4 unattended fetches a day),
 * then cool-down alerts, and the weekly read on Monday mornings. */
export function runScheduler() {
  // The demo's banks are made up: nothing to sync, no alerts to send. EBBY_SCHEDULER=off keeps tests' data still.
  if (config.DEMO || started || !config.SCHEDULER) return;
  started = true;

  const forUser = async () => {
    const last = await db.connect(async (conn) => {
      if ((await db.getMeta(conn, "categories_version")) !== categories.VERSION) {
        await ingest.recategorize(conn);  // categories changed since this history was sorted
        await db.setMeta(conn, "categories_version", categories.VERSION);
      }
      return db.getMeta(conn, "last_attempt");
    });
    const due = !last || parseIso(last).getTime() < clock.now().getTime() - config.SYNC_HOURS * 3600_000;
    if (due) await sync();
    // Also flushes alerts held back during quiet hours.
    await alerts.check();
    if (await weeklyReadDue()) {
      let read = null;
      try {
        read = await ai.weeklyRead();
      } catch (e) {
        if (e instanceof aiUsage.BudgetExceeded || e instanceof aiUsage.NoAPIKey) console.info(`no weekly read for user ${db.currentUser()}: ${e.message}`);
        else throw e;
      }
      if (read) await push.send("Your week", read.headline, "/", "weekly-read");
    }
  };

  const oneRound = async () => {
    let users: number[] = [];
    try { users = await db.activeUsers(); } catch (e) { console.error("couldn't list users", e); }
    for (const userId of users) {
      try {
        await db.asUser(userId, () => withPayCalendar(forUser));
      } catch (e) {  // e.g. the key file is missing; log it and keep the loop alive
        console.error(`scheduled work failed for user ${userId}`, e);
      }
    }
  };

  const loop = async () => {
    // Every pod runs this loop; one round at a time across them, so each sees what the last wrote (last_attempt,
    // alerts sent) and nothing is fetched or sent twice.
    try {
      await db.advisoryLock(db.LOCK_SCHEDULER, 0, async (mine) => { if (mine) await oneRound(); });
    } catch (e) {
      console.error("scheduler round failed", e);
    }
    setTimeout(loop, 300_000).unref();
  };
  void loop();
}

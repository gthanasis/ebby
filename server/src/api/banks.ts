/** Connecting banks and syncing them: status, the bank list, the bank's approval round trip, live syncs. */

import { isIPv4, isIPv6 } from "node:net";

import type { Context, Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";

import * as clock from "../clock.js";
import { config } from "../config.js";
import * as credentials from "../data/credentials.js";
import * as db from "../data/db.js";
import * as alerts from "../domain/alerts.js";
import * as banks from "../integrations/banks.js";
import { EnableBankingError } from "../integrations/enable_banking.js";
import * as sync from "../jobs/sync.js";
import { parseIso } from "../py.js";
import { body, fail } from "./http.js";
import { CASH_ACCOUNT } from "../domain/constants.js";
import { questions } from "../domain/questions.js";
import { thisMonth } from "../domain/months.js";

const LIVE_SYNC_MINUTES = 15;

/** Python's urllib.parse.quote. */
const quote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%2F", "/");

const v4 = (ip: string) => ip.split(".").reduce((n, p) => n * 256 + parseInt(p, 10), 0);
const inV4 = (ip: number, base: string, bits: number) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(v4(base) / 2 ** (32 - bits));
const PRIVATE_V4: [string, number][] = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]];

/** Python's ipaddress.ip_address(ip).is_global, for the addresses requests come from. */
export function isGlobal(ip: string): boolean {
  if (isIPv4(ip)) { const n = v4(ip); return !PRIVATE_V4.some(([b, bits]) => inV4(n, b, bits)); }
  if (!isIPv6(ip)) return false;
  const l = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (mapped) return isGlobal(mapped[1]);
  return !(l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith("2001:db8") || l.startsWith("2001:0db8"));
}

/** The account holder's own IP and browser, so the bank treats the fetch as them being present. null when there's
 * no public IP to send (e.g. on the home network without Cloudflare). */
function psuHeaders(c: Context): Record<string, string> | null {
  let remote = "";
  try { remote = getConnInfo(c).remote.address ?? ""; } catch { /* not on a node socket (tests) */ }
  const ip = c.req.header("cf-connecting-ip") || (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || remote;
  if (!isGlobal(ip)) return null;
  const headers: Record<string, string> = { "Psu-Ip-Address": ip };
  for (const [src, dst] of [["user-agent", "Psu-User-Agent"], ["accept-language", "Psu-Accept-Language"],
    ["accept", "Psu-Accept"], ["accept-encoding", "Psu-Accept-Encoding"]]) {
    const v = c.req.header(src);
    if (v) headers[dst] = v;
  }
  return headers;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function routes(app: Hono) {
  app.get("/api/status", async (c) => {
    const [accounts, connections, openQuestions] = await db.connect(async (conn) => [
      (await conn.execute(
        "SELECT id, bank, name, is_card, last4, balance, balance_at, synced_at, "
        + "(SELECT COUNT(*) FROM transactions t WHERE t.account = a.id) AS transactions, "
        + "(SELECT MIN(date) FROM transactions t WHERE t.account = a.id) AS since "
        + "FROM accounts a ORDER BY bank, is_card, name")).rows,
      // The banks you've connected or started to; the rest are offered from GET /api/banks.
      (await db.connections(conn)).map((x) => ({ bank: x.bank, connected: Boolean(x.session_id), valid_until: x.valid_until, last_sync: x.last_sync, last_error: x.last_error })),
      (await questions(conn)).length,
    ] as const);
    const synced = connections.map((x) => x.last_sync).filter(Boolean).sort();
    return c.json({
      connections, last_sync: synced[0] ?? null, syncing: await sync.isSyncing(), sync_hours: config.SYNC_HOURS,
      // True when the bank redirects back to this app, so connecting needs no copy-paste.
      callback_in_app: !config.REDIRECT_URL.includes("localhost"),
      questions: openQuestions,
      month: thisMonth(),  // the pay month today is in
      accounts: accounts.filter((a) => a.id !== CASH_ACCOUNT),
    });
  });

  app.post("/api/sync", async (c) => {
    if (await sync.isSyncing()) return c.json({ started: false }, 202);
    sync.background(() => sync.sync());
    return c.json({ started: true }, 202);
  });

  /** Every bank Enable Banking connects in this country, for personal accounts. */
  app.get("/api/banks", async (c) => {
    try {
      return c.json({ country: config.COUNTRY, banks: await banks.available() });
    } catch (e) {
      if (e instanceof credentials.MissingCredential) return fail(400, e.message);
      if (e instanceof EnableBankingError) return fail(502, `Couldn't get the list of banks from Enable Banking (${e.message}). Try again in a bit.`);
      throw e;
    }
  });

  app.post("/api/auth/start", async (c) => {
    const b = await body(c, z.object({ bank: z.string() }));
    try {
      return c.json({ url: await sync.startAuth(b.bank) });
    } catch (e) {
      if (e instanceof EnableBankingError) return fail(502, e.message);
      return fail(400, message(e));
    }
  });

  app.post("/api/auth/complete", async (c) => {
    const b = await body(c, z.object({ address: z.string() }));
    try {
      const [bank, count] = await sync.completeAuth(b.address);
      return c.json({ bank, accounts: count });
    } catch (e) {
      if (e instanceof EnableBankingError) return fail(502, e.message);
      return fail(400, message(e));
    }
  });

  /** Called when the app is opened: fresh data, at most every LIVE_SYNC_MINUTES. */
  app.post("/api/sync/live", async (c) => {
    const psu = psuHeaders(c);
    if (!psu) return c.json({ started: false, reason: "no public IP to send" });
    if (await sync.isSyncing()) return c.json({ started: false, reason: "already syncing" });
    const last = await db.connect((conn) => db.getMeta(conn, "last_live_sync"));
    if (last && parseIso(last).getTime() > clock.now().getTime() - LIVE_SYNC_MINUTES * 60_000) return c.json({ started: false, reason: "synced recently" });
    sync.background(async () => { if (await sync.sync(psu)) await alerts.check(); });
    return c.json({ started: true });
  });

  /** Where the bank sends you back after approving (EB_REDIRECT_URL on a real hostname). */
  app.get("/eb-callback", async (c) => {
    const page = (await db.connect((conn) => db.getMeta(conn, "onboarded"))) ? "accounts" : "welcome";  // back to wherever they connected from
    try {
      const [bank, count] = await sync.completeAuth(c.req.url);
      return c.redirect(`/#/${page}/connected=${quote(bank)}&accounts=${count}`, 303);
    } catch (e) {
      return c.redirect(`/#/${page}/error=${quote(message(e))}`, 303);
    }
  });
}

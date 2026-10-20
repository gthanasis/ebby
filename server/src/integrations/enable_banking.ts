/** Thin Enable Banking API client (restricted mode: each person's own app reaches only their own accounts). */

import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";

import * as clock from "../clock.js";
import { config } from "../config.js";
import { isoUtc, PyDate } from "../utils/python.js";

export const API = "https://api.enablebanking.com";

// Alpha Bank silently truncates large responses (30-50 newest rows, no continuation key), so history is fetched
// in small windows and any window that looks full is split.
export const WINDOW_DAYS = 14;
export const SUSPECT_FULL = 30;
export const MAX_HISTORY_DAYS = 545;

export class EnableBankingError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
  /** The message on its own (the Python app's e.message). */
  get detail() { return this.message; }
  get sessionExpired() {
    return ["EXPIRED_SESSION", "REVOKED_SESSION", "CLOSED_SESSION"].includes(this.code) || this.status === 401;
  }
  override toString() { return `${this.status} ${this.code}: ${this.message}`; }
}

export type Psu = Record<string, string> | null;
type Row = Record<string, any>;

export class Client {
  private token = "";
  private tokenExp = 0;

  /** A person's own restricted-mode application: its ID and private key (see credentials). */
  constructor(readonly appId: string, readonly key: Buffer) {}

  private async headers(): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    if (now > this.tokenExp - 60) {
      this.tokenExp = now + 3600;
      const pkcs8 = createPrivateKey(this.key).export({ type: "pkcs8", format: "pem" }).toString();
      const signing = await importPKCS8(pkcs8, "RS256");
      this.token = await new SignJWT({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: this.tokenExp })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: this.appId }).sign(signing);
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  /** psu: headers saying the account holder is using the app right now (Psu-Ip-Address, ...). Sent only for
   * requests the user triggered; banks then don't count them toward the ~4 unattended fetches a day. */
  async call(method: string, path: string, opts: { psu?: Psu; params?: Record<string, string>; json?: unknown } = {}): Promise<any> {
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { ...(await this.headers()), ...(opts.psu ?? {}) };
    if (opts.json !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(url, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) {
      const text = await r.text();
      let body: Row = {};
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      throw new EnableBankingError(r.status, String(body.error || body.code || ""), body.message || text);
    }
    return r.json();
  }

  async aspsps(country: string): Promise<Row[]> {
    return (await this.call("GET", "/aspsps", { params: { country } })).aspsps;
  }

  /** days: how long access lasts, at most what the bank allows (banks.available()'s consent_days). */
  async startAuth(bank: string, state: string, days = config.CONSENT_DAYS): Promise<string> {
    const validUntil = new Date(clock.now().getTime() + days * 86_400_000);
    return (await this.call("POST", "/auth", { json: {
      access: { valid_until: isoUtc(validUntil) },
      aspsp: { name: bank, country: config.COUNTRY },
      state, redirect_url: config.REDIRECT_URL, psu_type: "personal",
    } })).url;
  }

  createSession(code: string): Promise<Row> {
    return this.call("POST", "/sessions", { json: { code } });
  }

  async balances(uid: string, psu: Psu = null): Promise<Row[]> {
    return (await this.call("GET", `/accounts/${uid}/balances`, { psu })).balances ?? [];
  }

  async window(uid: string, start: PyDate, end: PyDate, psu: Psu = null): Promise<Row[]> {
    let params: Record<string, string> = { date_from: start.isoformat(), date_to: end.isoformat() };
    let rows: Row[] = [];
    for (;;) {
      const page = await this.call("GET", `/accounts/${uid}/transactions`, { psu, params });
      rows = rows.concat(page.transactions ?? []);
      const key = page.continuation_key;
      if (!key) break;
      params = { ...params, continuation_key: key };
    }
    if (rows.length >= SUSPECT_FULL && start.n < end.n) {
      const mid = start.addDays(Math.floor(end.diffDays(start) / 2));
      return [...await this.window(uid, start, mid, psu), ...await this.window(uid, mid.addDays(1), end, psu)];
    }
    return rows;
  }

  /** Yields [start, end, rows] per window, newest first, covering the last `days` days. */
  async *transactions(uid: string, days: number, psu: Psu = null): AsyncGenerator<[PyDate, PyDate, Row[]]> {
    const today = clock.serverToday();
    const oldest = today.addDays(-Math.min(days, MAX_HISTORY_DAYS));
    let end = today;
    while (end.n >= oldest.n) {
      const start = PyDate.ofDays(Math.max(oldest.n, end.addDays(-(WINDOW_DAYS - 1)).n));
      yield [start, end, await this.window(uid, start, end, psu)];
      end = start.addDays(-1);
    }
  }
}


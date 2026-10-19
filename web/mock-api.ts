/* Dev-only stand-in for the multi-user API, so onboarding can be clicked through without the backend.
 * `npm run dev:mock`. Reset with /__mock/reset. Not part of the build: only vite.config.ts imports it, and only in serve mode.
 *
 * Errors to try: an application ID that isn't a UUID, a file that isn't a PEM key, an ID starting 00000000 (Enable
 * Banking refuses it), Decline on the fake bank page, an Anthropic key not starting sk-ant-, inviting someone twice.
 *
 * Shortcuts: /__mock/ready (set up and onboarded), /__mock/admin?on=0|1, /__mock/spent?usd=2 (2 = allowance used up:
 * the assistant and Explain answer 429). */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

// What Enable Banking lists for Greece, personal accounts.
const BANKS = ["Airwallex", "Alpha Bank", "bunq", "Credia Bank", "DiPocket", "Epirus Bank", "Eurobank", "Genome", "iBanFirst", "N26",
  "National Bank of Greece", "Optima bank", "PayPal", "Piraeus Bank", "Revolut", "Snappi", "Trade Republic", "Wise"];
const fresh = () => ({
  signedIn: true, access: null as null | { app_id: string; key_fingerprint: string; verified_at: string },
  accounts: {} as Record<string, number>, done: false, syncing: false, settings: {} as Record<string, unknown>,
  anthropic: null as null | { masked: string; verified_at: string }, admin: true, spent: 0.84, people: PEOPLE(),
});
const PEOPLE = () => [
  { id: 1, email: "maria@example.com", name: "Maria Papadopoulou", picture: null, is_admin: true, status: "active", ai_budget_usd: 2, ai_spent_usd: 0.84,
    created_at: "2026-09-02T10:00:00Z", last_login_at: "2026-10-18T08:12:00Z" },
  { id: 2, email: "nikos.k@example.com", name: "Nikos Karalis", picture: null, is_admin: false, status: "active", ai_budget_usd: 2, ai_spent_usd: 1.71,
    created_at: "2026-10-01T18:20:00Z", last_login_at: "2026-10-17T21:40:00Z" },
  { id: 3, email: "eleni.v@example.com", name: null, picture: null, is_admin: false, status: "invited", ai_budget_usd: 2, ai_spent_usd: 0,
    created_at: "2026-10-15T09:00:00Z", last_login_at: null },
  { id: 4, email: "old.flatmate@example.com", name: "Giorgos Antoniou", picture: null, is_admin: false, status: "disabled", ai_budget_usd: 1, ai_spent_usd: 0,
    created_at: "2026-09-10T12:00:00Z", last_login_at: "2026-09-20T12:00:00Z" },
];
const ALLOWANCE = "You've used this month's AI allowance. It resets on 1 November, or add your own Anthropic key in Settings.";
const overAllowance = () => !state.anthropic && !state.admin && state.spent >= 2;
let state = fresh();

const send = (res: ServerResponse, code: number, body?: unknown) => {
  res.statusCode = code;
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};
const redirect = (res: ServerResponse, to: string) => { res.statusCode = 302; res.setHeader("Location", to); res.end(); };
const readBody = (req: IncomingMessage) => new Promise<Buffer>((ok) => {
  const parts: Buffer[] = [];
  req.on("data", (c: Buffer) => parts.push(c)).on("end", () => ok(Buffer.concat(parts)));
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function status() {
  const accounts = Object.entries(state.accounts).flatMap(([bank, n]) => Array.from({ length: n }, (_, i) => ({
    id: `${bank}-${i}`, bank, name: i === 0 ? "Current account" : `Card ${i}`, is_card: i ? 1 : 0, last4: i ? String(4100 + i) : null,
    balance: null, balance_at: null, synced_at: null, transactions: 0, since: null,
  })));
  return {
    connections: Object.keys(state.accounts).map((bank) => ({
      bank, connected: true, valid_until: bank in state.accounts ? "2027-04-16" : null, last_sync: null, last_error: null,
    })),
    last_sync: null, syncing: state.syncing, sync_hours: 6, accounts, callback_in_app: true, questions: 0, month: "2026-10",
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = new URL(req.url ?? "/", "http://mock");
  const route = `${req.method} ${url.pathname}`;

  if (url.pathname === "/__mock/reset") { state = fresh(); return redirect(res, "/"); }
  if (url.pathname === "/__mock/ready") {
    state = { ...fresh(), done: true, accounts: { Revolut: 1, "Alpha Bank": 3 }, settings: { owner_names: ["PAPADOPOULOU MARIA", "Maria Papadopoulou"] },
      access: { app_id: "3f2b8c1e-5a4d-4e8f-9b21-7c6d0e1f2a3b", key_fingerprint: "SHA256:28:6e:0d:75:b8:45:1b:c3", verified_at: "2026-10-12T09:30:00Z" } };
    return redirect(res, "/#/settings");
  }
  if (url.pathname === "/__mock/admin") { state.admin = url.searchParams.get("on") !== "0"; return redirect(res, "/#/settings"); }
  if (url.pathname === "/__mock/spent") { state.spent = Number(url.searchParams.get("usd") ?? 0); return redirect(res, "/#/settings/section=ai"); }
  if (route === "GET /auth/google") { state.signedIn = true; return redirect(res, "/#/welcome"); }
  if (route === "POST /auth/logout") { state.signedIn = false; return redirect(res, "/#/login/signed_out=1"); }
  if (url.pathname === "/__mock/bank") {
    const bank = url.searchParams.get("bank") ?? "";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(`<body style="font:16px system-ui;padding:40px"><h2>${bank} (mock)</h2><p>Allow Spending to read your accounts?</p>
      <p><a href="/__mock/approve?bank=${encodeURIComponent(bank)}">Approve</a> · <a href="/__mock/decline?bank=${encodeURIComponent(bank)}">Decline</a></p></body>`);
  }
  if (url.pathname === "/__mock/approve") {
    const bank = url.searchParams.get("bank") ?? "";
    const n = bank === "Revolut" ? 1 : 3;
    state.accounts[bank] = n;
    state.syncing = true;
    setTimeout(() => { state.syncing = false; }, 20000);
    return redirect(res, `/#/welcome/connected=${encodeURIComponent(bank)}&accounts=${n}`);
  }
  if (url.pathname === "/__mock/decline") {
    return redirect(res, `/#/welcome/error=${encodeURIComponent(`You declined access in ${url.searchParams.get("bank")}'s app. Try again when you're ready.`)}`);
  }
  if (!url.pathname.startsWith("/api/")) return next();
  if (!state.signedIn) return send(res, 401, { detail: "Not signed in" });

  switch (route) {
    case "GET /api/me":
      return send(res, 200, {
        email: "maria@example.com", name: "Maria Papadopoulou", picture: null, is_admin: state.admin,
        ai_budget_usd: 2, ai_spent_usd: state.spent,
        credentials: { ...(state.access ? { enable_banking: state.access } : {}), ...(state.anthropic ? { anthropic: state.anthropic } : {}) },
        onboarding: { bank_access: !!state.access, banks_connected: Object.keys(state.accounts).length, done: state.done },
      });
    case "GET /api/status": return send(res, 200, status());
    case "GET /api/banks":
      if (!state.access) return send(res, 400, { detail: "Add your Enable Banking application first." });
      return send(res, 200, { country: "GR", banks: BANKS.map((name) => ({ name, logo: null, beta: true, consent_days: name === "Trade Republic" ? 90 : 180 })) });
    case "GET /api/categories": return send(res, 200, []);
    case "POST /api/credentials/enable-banking": {
      const body = (await readBody(req)).toString("utf8");
      const appId = /name="app_id"\r\n\r\n([^\r]*)/.exec(body)?.[1]?.trim() ?? "";
      const pem = /name="pem"[^\r]*\r\n[^\r]*\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1] ?? "";
      await wait(1400);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)) {
        return send(res, 400, { detail: "That isn't an application ID. It's the long ID with dashes on your application's page in Enable Banking." });
      }
      if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(pem)) {
        return send(res, 400, { detail: "That file isn't a private key. Use the .pem file Enable Banking gave you for this application." });
      }
      if (appId.startsWith("00000000")) {
        return send(res, 502, { detail: "Enable Banking didn't accept this key for that application. Check the application ID belongs to the same app as the key." });
      }
      const hex = createHash("sha256").update(pem).digest("hex");
      state.access = { app_id: appId, key_fingerprint: `SHA256:${hex.slice(0, 16).match(/../g)!.join(":")}`, verified_at: new Date().toISOString() };
      return send(res, 200, state.access);
    }
    case "POST /api/auth/start": {
      const { bank } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!state.access) return send(res, 400, { detail: "Add your Enable Banking key first." });
      await wait(500);
      return send(res, 200, { url: `/__mock/bank?bank=${encodeURIComponent(bank)}` });
    }
    case "PUT /api/settings": {
      Object.assign(state.settings, JSON.parse((await readBody(req)).toString() || "{}"));
      return send(res, 200, state.settings);
    }
    case "POST /api/credentials/anthropic": {
      const { api_key } = JSON.parse((await readBody(req)).toString() || "{}");
      await wait(800);
      if (!String(api_key).startsWith("sk-ant-") || String(api_key).length < 20) {
        return send(res, 400, { detail: "Anthropic didn't accept this key. Copy it again from console.anthropic.com." });
      }
      state.anthropic = { masked: `…${String(api_key).slice(-4)}`, verified_at: new Date().toISOString() };
      return send(res, 200, { masked: state.anthropic.masked });
    }
    case "DELETE /api/credentials/enable_banking": state.access = null; state.accounts = {}; return send(res, 204);
    case "DELETE /api/credentials/anthropic": state.anthropic = null; return send(res, 204);
    case "GET /api/plan":
      return send(res, 200, { plan: null, averages: {}, committed: 0, settings: state.settings, devices: 0, ai: true, payday_detected: null, extra_pay: [] });
    case "GET /api/commitments": return send(res, 200, { month: "2026-10", items: [], suggestions: [], limit: 0, spent: 0, over: [] });
    case "GET /api/assistant":
      return send(res, 200, { conversation: 1, items: [], questions: [], cash: { withdrawn: 0, logged: 0, unaccounted: 0 }, ai: true });
    case "POST /api/assistant/chat/stream": {
      res.setHeader("Content-Type", "text/event-stream");
      const event = overAllowance() ? { type: "error", text: ALLOWANCE, code: "allowance" }
        : { type: "done", conversation: 1, items: [{ type: "me", text: "hi" }, { type: "bot", text: "This is the mock. Ask the real backend." }] };
      return res.end(`data: ${JSON.stringify(event)}\n\n`);
    }
    case "POST /api/spending/explain":
      return overAllowance() ? send(res, 429, { detail: ALLOWANCE }) : send(res, 502, { detail: "The mock can't explain anything." });
    case "GET /api/people":
      return state.admin ? send(res, 200, state.people) : send(res, 403, { detail: "Only the admin can manage people." });
    case "POST /api/people": {
      const { email } = JSON.parse((await readBody(req)).toString() || "{}");
      const e = String(email ?? "").trim().toLowerCase();
      if (!e.includes("@")) return send(res, 400, { detail: "That isn't an email address." });
      if (state.people.some((p) => p.email === e)) return send(res, 400, { detail: `${e} is already on the list.` });
      const p = { id: state.people.length + 1, email: e, name: null, picture: null, is_admin: false, status: "invited", ai_budget_usd: 2, ai_spent_usd: 0,
        created_at: new Date().toISOString(), last_login_at: null };
      state.people.push(p);
      return send(res, 200, p);
    }
    case "POST /api/onboarding/done": state.done = true; return send(res, 204);
  }
  const person = /^PATCH \/api\/people\/(\d+)$/.exec(route);
  if (person) {
    const change = JSON.parse((await readBody(req)).toString() || "{}");
    const p = state.people.find((x) => x.id === Number(person[1]));
    if (p && !p.is_admin) Object.assign(p, change);
    await wait(400);
    return send(res, 200, state.people);
  }
  return send(res, 404, { detail: `${route} isn't in the mock` });
}

export function mockApi(): Plugin {
  return {
    name: "mock-api",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => { handle(req, res, next).catch((e) => send(res, 500, { detail: String(e) })); });
    },
  };
}

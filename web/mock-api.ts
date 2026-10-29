/* Dev-only stand-in for the multi-user API, so onboarding can be clicked through without the backend.
 * `npm run dev:mock`. Reset with /__mock/reset. Not part of the build: only vite.config.ts imports it, and only in serve mode.
 *
 * Errors to try: an application ID that isn't a UUID, a file that isn't a PEM key, an ID starting 00000000 (Enable
 * Banking refuses it), Decline on the fake bank page, an Anthropic key not starting sk-ant-, inviting someone twice.
 *
 * Shortcuts: /__mock/ready (set up and onboarded), /__mock/admin?on=0|1, /__mock/spent?usd=2 (2 = allowance used up:
 * the assistant and Explain answer 429), /__mock/overview?state=ok|behind|over|late (how this month is going). */
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
  overview: "ok" as "ok" | "behind" | "over" | "late", nextLimit: null as number | null, goalSaved: 240,
  memory: MEMORY(), pinned: {} as Record<string, number | null>, payeeNames: {} as Record<string, string>,
});
const MEMORY = () => [
  { id: 2, text: "Revolut top-ups are moves between my own accounts.", source: "chat", service: null, created_at: "2026-08-18T10:00:00Z", used: 9 },
  { id: 1, text: "Transfers to M. Papadopoulou are my half of the rent.", source: "payment", service: "M. Papadopoulou", created_at: "2026-09-03T19:12:00Z", used: 2 },
];
// A few payments for the list, with IRIS transfers that name people only by a phone number: [id, date, amount, bank text, payee, category, account]
const PAYMENTS: [string, string, number, string, string, string, string][] = [
  ["m1", "2026-10-29", -45, "To ELENI MARKOU", "Eleni Markou", "people", "Fun fund"],
  ["m2", "2026-10-27", -60, "ΙRΙS 6900000001", "Iris 6900000001", "people", "Alpha Μισθοδοσία"],
  ["m3", "2026-10-27", -40, "ΙRΙS 100000002", "Iris 100000002", "people", "Alpha Μισθοδοσία"],
  ["m4", "2026-10-26", -31, "ΙRΙS 6900000003", "Iris 6900000003", "people", "Alpha Μισθοδοσία"],
  ["m5", "2026-10-26", -19.45, "ΜΑRΚΕΤ ΙΝ", "Market In", "groceries", "Alpha Ταμιευτήριο"],
  ["m6", "2026-10-12", -50, "ΙRΙS 6900000001", "Iris 6900000001", "people", "Alpha Μισθοδοσία"],
];
const payeeOf = (id: string) => PAYMENTS.find((p) => p[0] === id)?.[4] ?? "";
const payments = () => PAYMENTS.map(([id, date, amount, description, payee, category, account_name]) => ({
  id, date, amount, currency: "EUR", status: "BOOK", description, merchant: state.payeeNames[payee] ?? payee, mcc: null, category,
  commitment_id: null, account_name, is_card: 0, booked: null,
}));
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
// The sorter: payments the rules couldn't place, as /api/sorter lists them, and what the assistant would guess.
const CATEGORIES: [string, string, string, boolean][] = [
  ["groceries", "Groceries", "mdi:cart-outline", true], ["eating_out", "Eating out", "mdi:silverware-fork-knife", true],
  ["delivery", "Delivery", "mdi:moped-outline", true], ["coffee_bars", "Coffee & bars", "mdi:coffee-outline", true],
  ["car", "Car & transport", "mdi:car-outline", true], ["subscriptions", "Subscriptions & tech", "mdi:laptop", true],
  ["shopping", "Shopping", "mdi:shopping-outline", true], ["bills", "Bills", "mdi:file-document-outline", true],
  ["housing", "Rent & home", "mdi:home-outline", true], ["loans", "Loans & mortgage", "mdi:bank-transfer-out", true],
  ["insurance", "Insurance", "mdi:shield-check-outline", true], ["health", "Health & fitness", "mdi:heart-pulse", true],
  ["personal_care", "Personal care", "mdi:content-cut", true], ["travel", "Travel", "mdi:airplane", true],
  ["leisure", "Leisure", "mdi:ticket-outline", true], ["pets", "Pets", "mdi:paw-outline", true],
  ["kids", "Kids", "mdi:baby-face-outline", true], ["education", "Education", "mdi:school-outline", true],
  ["gifts", "Gifts & donations", "mdi:gift-outline", true], ["people", "Sent to people", "mdi:account-arrow-right-outline", true],
  ["cash", "Cash", "mdi:cash", true], ["fees", "Fees & taxes", "mdi:bank-outline", true], ["other", "Other", "mdi:dots-horizontal", true],
  ["income", "Income", "mdi:arrow-down-circle-outline", false], ["transfer", "Own transfers", "mdi:swap-horizontal", false],
  ["investments", "Investments", "mdi:chart-line", false], ["card_payment", "Card repayments", "mdi:credit-card-check-outline", false],
];
const SORT = () => [
  { service: "Interamerican", tx_id: "s1", date: "2026-10-14", days_ago: 6, amount: 86.4, count: 1, total: 86.4, how: "Alpha Bank current account",
    shop: null, description: "INTERAMERICAN ΑΕΑΖ ΠΛΗΡΩΜΗ", same_day: [{ name: "Sklavenitis", amount: 42.17, category: "groceries" }],
    history: [{ date: "2026-07-14", amount: 86.4 }, { date: "2026-04-14", amount: 86.4 }], guess: null,
    _guess: { category: "insurance", reason: "Interamerican is an insurer, and the same €86.40 leaves every three months: a quarterly premium." } },
  { service: "Frontistirio Praxis", tx_id: "s2", date: "2026-10-05", days_ago: 15, amount: 140, count: 1, total: 140, how: "Card ending 4101",
    shop: "Educational services", description: "FRONTISTIRIO PRAXIS", same_day: [],
    history: [{ date: "2026-09-05", amount: 140 }], guess: null,
    _guess: { category: "bills", reason: "A fixed €140 on the 5th of each month looks like a regular bill." } },
  { service: "Kafe Mikro", tx_id: "s3", date: "2026-10-18", days_ago: 2, amount: 4.2, count: 6, total: 25.2, how: "Card ending 4101",
    shop: "Eating places", description: "KAFE MIKRO ATHINA", same_day: [{ name: "Wolt", amount: 18.5, category: "delivery" }],
    history: [{ date: "2026-10-16", amount: 3.8 }, { date: "2026-10-11", amount: 4.2 }], guess: null,
    _guess: { category: "coffee_bars", reason: "Small amounts most mornings at a place called Kafe: coffee." } },
  { service: "Trade Republic", tx_id: "s4", date: "2026-10-01", days_ago: 19, amount: 200, count: 1, total: 200, how: "Alpha Bank current account",
    shop: null, description: "TRADE REPUBLIC BANK GMBH", same_day: [], history: [{ date: "2026-09-01", amount: 200 }], guess: null,
    _guess: { category: "investments", reason: "€200 to a broker on the 1st each month: a savings plan, not spending." } },
];
let sorter = { left: SORT(), answered: [] as ReturnType<typeof SORT> };

// Overview: a pay month from 25 Sep to 22 Oct (paid on the 25th), on 20 Oct. Fixed costs as Overview lists them.
const COSTS = [{ id: 1, name: "Rent" }, { id: 2, name: "Loan" }, { id: 3, name: "Internet · Cosmote" }, { id: 4, name: "Gym" }];
const FIXED = () => {
  const items = [
    { id: 2, name: "Loan", kind: "fixed", expected: 155, paid: 0, status: "due", paid_on: null, due_on: "2026-10-21", count: 0 },
    { id: 3, name: "Internet · Cosmote", kind: "fixed", expected: 35, paid: 35, status: "paid", paid_on: "2026-10-03", due_on: null, count: 1 },
    { id: 4, name: "Gym", kind: "chosen", expected: 40, paid: 40, status: "paid", paid_on: "2026-10-02", due_on: null, count: 1 },
    { id: 1, name: "Rent", kind: "fixed", expected: 750, paid: 750, status: "paid", paid_on: "2026-10-01", due_on: null, count: 1 },
  ];
  return { items, paid: 825, due: 155, expected: 980 };
};
function home() {
  const spent = { ok: 640, behind: 860, over: 1010, late: 905 }[state.overview];
  const length = state.overview === "late" ? 32 : 28, elapsed = state.overview === "late" ? 32 : 26;
  const day = (i: number) => new Date(Date.UTC(2026, 8, 25 + i)).toISOString().slice(0, 10);
  const weights = Array.from({ length: elapsed }, (_, i) => [0.6, 1.4, 0.8, 1.1, 0.2, 1.7, 0.9][i % 7]);
  const total = weights.reduce((a, b) => a + b, 0);
  const days = Array.from({ length }, (_, i) => ({
    date: day(i), spent: i < elapsed ? Math.round((weights[i] / total) * spent * 100) / 100 : null, fixed: { 6: 750, 7: 40, 8: 35 }[i] ?? 0,
  }));
  // Money taken from the goal is added to this month's budget, as the real server does with the month's limit.
  const budget = 950 + (240 - state.goalSaved);
  return {
    month: {
      month: "2026-10", start: "2026-09-25", end: state.overview === "late" ? "2026-10-27" : "2026-10-23", today: day(elapsed - 1),
      length, elapsed, spent, days, average: spent / elapsed, projected: (spent / elapsed) * length,
      categories: [{ category: "groceries", spent: spent * 0.32, count: 21 }, { category: "eating_out", spent: spent * 0.24, count: 11 },
        { category: "delivery", spent: spent * 0.18, count: 9 }, { category: "shopping", spent: spent * 0.16, count: 4 }, { category: "coffee_bars", spent: spent * 0.1, count: 31 }],
      ideal: { income: 2400, savings: 300, fixed: 980, goals: [{ name: "Lisbon in March", price: 900, target_date: "2027-03-15", monthly: 170 }],
        budget, planned: 950, day: budget / length, targets: {} },
      fixed: FIXED(), next_limit: state.nextLimit,
      goal: { id: 1, name: "Lisbon in March", price: 900, saved: state.goalSaved, target_date: "2027-03-15" },
      watch: state.overview === "ok" ? [{ category: "eating_out", spent: spent * 0.24, usual: spent * 0.24 - 46, count: 11 }]
        : [{ category: "eating_out", spent: spent * 0.24, usual: spent * 0.24 - 110, count: 11 }, { category: "delivery", spent: spent * 0.18, usual: spent * 0.18 - 54, count: 9 }],
    },
    fresh_at: "2026-10-20T07:40:00Z", payday_hint: null,
    pay_waiting: state.overview === "late" ? { expected: "2026-10-23", until: "2026-10-28", amount: 2400, payer: "ACME LTD" } : null,
    pay_arrived: null,
  };
}
const payment = (id: string) => {
  const listed = payments().find((p) => p.id === id);
  if (listed) return { id, date: listed.date, booked: null, amount: listed.amount, currency: "EUR", status: listed.status, category: listed.category,
    name: listed.merchant, merchant: listed.merchant, description: listed.description,
    account: { name: listed.account_name, bank: "Alpha Bank", last4: null, is_card: false },
    commitment_id: null, commitment: null, pinned: false, costs: COSTS, named: listed.merchant !== payeeOf(id) };
  const pinned = id in state.pinned ? state.pinned[id] : null;
  const rent = id === "t-rent";
  const cid = pinned ?? (rent ? 1 : null);
  return {
    id, date: rent ? "2026-10-01" : "2026-10-12", booked: rent ? null : "2026-10-13", amount: rent ? -750 : -23.4, currency: "EUR", status: "BOOK",
    category: rent ? "housing" : "groceries", name: rent ? "M. Papadopoulou" : "Sklavenitis", merchant: rent ? "" : "Sklavenitis",
    description: rent ? "ENOIKIO OKT" : "SKLAVENITIS 0412 ATHINA",
    account: { name: rent ? "Current account" : "Card 1", bank: "Alpha Bank", last4: rent ? null : "4101", is_card: !rent },
    commitment_id: cid, commitment: COSTS.find((c) => c.id === cid)?.name ?? null, pinned: pinned != null, costs: COSTS, named: false,
  };
};

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

  if (url.pathname === "/__mock/reset") { state = fresh(); sorter = { left: SORT(), answered: [] }; return redirect(res, "/"); }
  if (url.pathname === "/__mock/ready") {
    state = { ...fresh(), done: true, accounts: { Revolut: 1, "Alpha Bank": 3 }, settings: { owner_names: ["PAPADOPOULOU MARIA", "Maria Papadopoulou"] },
      access: { app_id: "3f2b8c1e-5a4d-4e8f-9b21-7c6d0e1f2a3b", key_fingerprint: "SHA256:28:6e:0d:75:b8:45:1b:c3", verified_at: "2026-10-12T09:30:00Z" } };
    return redirect(res, "/#/settings");
  }
  if (url.pathname === "/__mock/overview") {
    state.overview = (["ok", "behind", "over", "late"] as const).find((s) => s === url.searchParams.get("state")) ?? "ok";
    state.nextLimit = null; state.goalSaved = 240;
    return redirect(res, "/#/home");
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
    case "GET /api/categories": return send(res, 200, CATEGORIES.map(([id, label, icon, spending]) => ({ id, label, icon, spending })));
    case "GET /api/sorter":
      return send(res, 200, { items: sorter.left.map(({ _guess, ...it }) => it), ai: true });
    case "POST /api/sorter/guess": {
      const { service } = JSON.parse((await readBody(req)).toString());
      await wait(900);  // the assistant thinking
      const it = sorter.left.find((x) => x.service === service);
      return it ? send(res, 200, it._guess) : send(res, 404, { detail: "Nothing to guess" });
    }
    case "POST /api/assistant/answer": {
      const { service } = JSON.parse((await readBody(req)).toString());
      const it = sorter.left.find((x) => x.service === service);
      sorter.left = sorter.left.filter((x) => x.service !== service);
      if (it) sorter.answered.push(it);
      await wait(300);
      return send(res, 200, { moved: it?.count ?? 0, questions: [] });
    }
    case "POST /api/sorter/undo": {
      const { service } = JSON.parse((await readBody(req)).toString());
      const it = sorter.answered.find((x) => x.service === service);
      sorter.answered = sorter.answered.filter((x) => x.service !== service);
      if (it) sorter.left.unshift(it);
      return send(res, 200, { moved: it?.count ?? 0 });
    }
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
    case "GET /api/home": return send(res, 200, home());
    case "GET /api/fixed": return send(res, 200, FIXED());
    case "GET /api/payment": return send(res, 200, payment(url.searchParams.get("id") ?? "t-1"));
    case "PUT /api/payment/commitment": {
      const { id, commitment_id } = JSON.parse((await readBody(req)).toString() || "{}");
      state.pinned[id] = commitment_id;
      return send(res, 200, payment(id));
    }
    case "PUT /api/plan/limit": {
      // Overview's "take it from next month": the mock only remembers next month's limit.
      const { month, limit } = JSON.parse((await readBody(req)).toString() || "{}");
      if (month === "2026-11") state.nextLimit = limit;
      return send(res, 200, { take_home: 2400, keep: 300, budgets: {}, limits: { [month]: limit } });
    }
    case "GET /api/assistant/memory": return send(res, 200, state.memory);
    case "POST /api/assistant/memory": {
      const { text, service } = JSON.parse((await readBody(req)).toString() || "{}");
      if (!String(text ?? "").trim()) return send(res, 400, { detail: "Write what the assistant should remember" });
      const id = Math.max(0, ...state.memory.map((m) => m.id)) + 1;
      state.memory.unshift({ id, text: String(text).trim(), source: service ? "payment" : "you", service: service ?? null, created_at: new Date().toISOString(), used: 0 });
      return send(res, 200, state.memory);
    }
  }
  const memory = /^(PUT|DELETE) \/api\/assistant\/memory\/(\d+)$/.exec(route);
  if (memory) {
    const id = Number(memory[2]);
    if (memory[1] === "DELETE") state.memory = state.memory.filter((m) => m.id !== id);
    else {
      const { text } = JSON.parse((await readBody(req)).toString() || "{}");
      const m = state.memory.find((x) => x.id === id);
      if (!m) return send(res, 404, { detail: "No such line" });
      m.text = String(text).trim();
    }
    return send(res, 200, state.memory);
  }
  const goal = /^PATCH \/api\/goals\/(\d+)$/.exec(route);
  if (goal) {
    const { add } = JSON.parse((await readBody(req)).toString() || "{}");
    state.goalSaved = Math.max(0, state.goalSaved + (add ?? 0));
    return send(res, 200, []);
  }
  if (route === "GET /api/transactions") {
    const q = url.searchParams.get("q")?.toLowerCase(), category = url.searchParams.get("category");
    const rows = payments().filter((t) => (!q || `${t.merchant} ${t.description}`.toLowerCase().includes(q)) && (!category || t.category === category));
    return send(res, 200, { rows, total: rows.length, spent: -rows.reduce((s, t) => s + t.amount, 0) });
  }
  const payee = /^PUT \/api\/transactions\/(.+)\/payee$/.exec(route);
  if (payee) {
    const row = PAYMENTS.find((p) => p[0] === decodeURIComponent(payee[1]));
    if (!row) return send(res, 404, { detail: "No such transaction" });
    const name = String(JSON.parse((await readBody(req)).toString() || "{}").name ?? "").trim();
    if (name && name !== row[4]) state.payeeNames[row[4]] = name; else delete state.payeeNames[row[4]];
    await wait(300);
    const merchant = name || row[4];
    return send(res, 200, { ok: true, payee: row[4], merchant, payments: payments().filter((t) => t.merchant === merchant).length });
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

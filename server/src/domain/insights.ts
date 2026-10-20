/**
 * Everything the screens show beyond raw rows: the plan, pace against it, services, subscriptions, the year,
 * and where a goal's money can come from.
 *
 * All money here is euros spent (positive numbers), over spending categories only.
 */

import { randomBytes } from "node:crypto";

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import { type Conn, first, type Row } from "../data/db.js";
import { fmt0, maxBy, median, monthDays, monthName, PyDate, pyDumps, pyMod, pyRound, sorted, sum } from "../py.js";
import { CATEGORIES, SPENDING } from "./categories.js";
import { CASH_ACCOUNT, PAYDAY_MIN } from "./constants.js";
import { MCC_NAMES } from "./reference/mcc.js";

// Debit-card copies (duplicate_of set) are left out: their current-account row is the one that counts.
// Free spending: what the plan's budgets, alerts and cuts are about. Committed rows are kept apart.
export const SPEND_ARGS = sorted(SPENDING);
export const SPEND_SQL = `duplicate_of IS NULL AND commitment_id IS NULL AND currency = 'EUR' AND category IN (${SPEND_ARGS.map(() => "?").join(",")})`;
export const COMMITTED_SQL = "duplicate_of IS NULL AND commitment_id IS NOT NULL AND currency = 'EUR'";

// Trimmed harder when income doesn't cover habits; essentials barely move.
const DISCRETIONARY: Record<string, number> = {
  eating_out: 1.0, delivery: 1.0, shopping: 1.0, cash: 1.0, coffee_bars: 1.0,
  leisure: 1.0, subscriptions: 0.8, other: 0.8, travel: 0.8, people: 0.6,
  personal_care: 0.6, pets: 0.3, car: 0.4, health: 0.2, groceries: 0.3,
  bills: 0.1, housing: 0.0, fees: 0.5, loans: 0.0, insurance: 0.1, kids: 0.2,
  education: 0.3, gifts: 0.8,
};

// ---------- months ----------
// A "month" is a pay month: from one payday up to the day before the next. It's keyed YYYY-MM by the calendar
// month it mostly covers, so with pay on the 25th "2026-10" runs 25 Sep to 24 Oct. Payday 1 (the default) makes
// it the calendar month; "last" is the last working day. Pay that falls on a weekend arrives the Friday before,
// so the month starts then.

// Per person, read from their settings and kept a minute: monthBounds runs many times a request, and a change
// made on another pod reaches this one within that minute.
export let PAYDAY_TTL = 60_000;
export const _paydays = new Map<number, [number, Payday]>();
export type Payday = number | "last";

/** The current person's payday. Read from their settings before the month functions below are used. */
export async function loadPayday(): Promise<Payday> {
  const user = db.currentUser()!;
  const hit = _paydays.get(user);
  if (hit && performance.now() - hit[0] < PAYDAY_TTL) return hit[1];
  const day = await db.connect(async (conn) => (await db.getMeta<any>(conn, "settings"))?.payday || 1);
  const value: Payday = day === "last" ? "last" : parseInt(day, 10);
  _paydays.set(user, [performance.now(), value]);
  return value;
}

export function setPayday(day: Payday) {
  _paydays.set(db.currentUser()!, [performance.now(), day]);
}

/** The payday loadPayday() read for the current person. Every request and job loads it first (api, jobs). */
function payday(): Payday {
  const hit = _paydays.get(db.currentUser()!);
  if (!hit) throw new Error("payday not loaded: await insights.loadPayday() before using pay months");
  return hit[1];
}

function payDate(y: number, m: number, day: Payday): PyDate {
  const last = monthDays(y, m);
  const d = new PyDate(y, m, day === "last" ? last : Math.min(day, last));
  if (day === 1) return d;
  return d.addDays(-Math.max(0, d.weekday() - 4));  // Saturday/Sunday -> Friday
}

const ym = (month: string): [number, number] => month.split("-").map((p) => parseInt(p, 10)) as [number, number];

/** [first day, first day of the next month] of a pay month. */
export function monthBounds(month: string): [string, string] {
  const day = payday();
  if (day === 1) {
    const [y, m] = ym(month);
    return [`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`, new PyDate(y + (m === 12 ? 1 : 0), (m % 12) + 1, 1).isoformat()];
  }
  // Paid late in the month: that pay starts the next month. Paid early: it starts this one.
  const firstMonth = day === "last" || day > 15 ? shift(month, -1) : month;
  return [payDate(...ym(firstMonth), day).isoformat(), payDate(...ym(shift(firstMonth, 1)), day).isoformat()];
}

/** The pay month a day belongs to. */
export function monthOf(d: PyDate | string): string {
  const day = typeof d === "string" ? PyDate.fromisoformat(d) : d;
  const key = `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}`;
  const [start, end] = monthBounds(key);
  if (day.isoformat() < start) return shift(key, -1);
  if (day.isoformat() >= end) return shift(key, 1);
  return key;
}

export function shift(month: string, delta: number): string {
  const [y, m] = ym(month);
  const i = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(i / 12)).padStart(4, "0")}-${String(pyMod(i, 12) + 1).padStart(2, "0")}`;
}

export const localToday = () => clock.today();
export const thisMonth = () => monthOf(localToday());

/** [days elapsed including today, days in the month]; a past month counts as complete. */
export function dayProgress(month: string): [number, number] {
  const [start, end] = monthBounds(month).map(PyDate.fromisoformat);
  const days = end.diffDays(start);
  const today = localToday();
  if (start.n <= today.n && today.n < end.n) return [today.diffDays(start) + 1, days];
  return today.n >= end.n ? [days, days] : [0, days];
}

/** When pay seems to arrive: the day of month that the biggest monthly deposit keeps landing on. A Friday deposit
 * also counts for the weekend after it, since weekend pay comes early. */
export async function detectPayday(conn: Conn): Promise<Row | null> {
  const since = localToday().addDays(-240).isoformat();
  const biggest = new Map<string, Row>();
  for (const r of await conn.execute(`SELECT date, amount FROM transactions WHERE category = 'income' AND amount >= ? AND currency = 'EUR'
                                      AND duplicate_of IS NULL AND date >= ? ORDER BY date`, [PAYDAY_MIN, since])) {
    const k = r.date.slice(0, 7);
    if (!biggest.has(k) || r.amount > biggest.get(k)!.amount) biggest.set(k, r);
  }
  const votes = new Map<number, Row[]>();
  for (const r of biggest.values()) {
    const d = PyDate.fromisoformat(r.date);
    for (const extra of d.weekday() === 4 ? [0, 1, 2] : [0]) {
      const nd = d.addDays(extra);
      if (nd.month === d.month) {
        if (!votes.has(nd.day)) votes.set(nd.day, []);
        votes.get(nd.day)!.push(r);
      }
    }
  }
  if (!votes.size) return null;
  const [day, hits] = maxBy(votes.entries(), ([d, h]) => [h.length, d ? -d : 0])!;
  if (hits.length < 3) return null;
  const last = maxBy(hits, (r) => r.date)!;
  return { day, amount: pyRound(median(hits.map((r) => r.amount)), 2), last: last.date, months: hits.length };
}

// ---------- services ----------

const SERVICE_ALIASES: [RegExp, string][] = [
  [/SDDFTSID/u, "Direct debit"], [/ΔΙΑΦΟΡΕΣ ΠΛΗΡΩΜΕΣ/u, "Bill payment"],
  [/ANTHROPIC|CLAUDE/u, "Claude (Anthropic)"], [/OPENAI|CHATGPT/u, "OpenAI"], [/GOOGLE.?\*?ADS|GOOGLE ADS/u, "Google Ads"],
  [/GOOGLE/u, "Google"], [/SPOTIFY/u, "Spotify"], [/NETFLIX/u, "Netflix"], [/ITUNES|APPLE\.COM/u, "Apple"],
  [/CURSOR/u, "Cursor"], [/GITHUB/u, "GitHub"], [/PATREON/u, "Patreon"], [/HETZNER/u, "Hetzner"],
  [/CLOUDFLARE/u, "Cloudflare"], [/COSMOTE/u, "Cosmote"], [/VODAFONE/u, "Vodafone"], [/WOLT/u, "Wolt"],
  [/EFOOD/u, "efood"], [/UBR\*|UBER/u, "Uber"], [/AMAZON|AMZN/u, "Amazon"], [/SKROUTZ/u, "Skroutz"],
  [/YOUTUBE/u, "YouTube"], [/DISNEY/u, "Disney+"], [/STEAM/u, "Steam"],
];

// Python's \s, \d and \w, which are Unicode-aware.
const TRAILING_REF = /[\s*#_-]*[A-Z]?\p{Nd}[\p{L}\p{N}\p{Mn}_-]*$/u;

/** One name per service, so 'Google*Ads9252660411' and 'Google Ads9252660411' add up together. */
export function serviceName(merchant: string | null, description: string | null, isCard: boolean, mcc: string | null): string {
  if (!merchant) {
    if (isCard) return `Card · ${MCC_NAMES[String(mcc || "")] ?? "purchases"}`;
    merchant = description || "Unknown";
  }
  const key = merchant.toUpperCase();
  for (const [pattern, name] of SERVICE_ALIASES) if (pattern.test(key)) return name;
  // Drop trailing references: "Ab Kirseli 2", "Mytrip 1147531613", "Spotify*P446".
  const name = merchant.replace(TRAILING_REF, "").replace(/^[ *-]+|[ *-]+$/g, "");
  return name || merchant;
}

const sn = (r: Row) => serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc);

// ---------- plan ----------

/** Average monthly spend per category over the last `months` complete months. */
export async function averages(conn: Conn, months = 6): Promise<Record<string, number>> {
  const end = monthBounds(thisMonth())[0];
  const start = monthBounds(shift(thisMonth(), -months))[0];
  const rows = (await conn.execute(`
    SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
  return Object.fromEntries(rows.map((r) => [r.category, Math.max(0.0, r.spent / months)]));
}

const round10 = (v: number) => Math.max(10.0, pyRound(v / 10) * 10);
const roundTo = (v: number, step: number) => pyRound(v / step) * step;

/** Splits take-home minus savings across categories. When habits cost more than that, discretionary categories
 * are trimmed hardest (never below 20% of their average). */
export async function suggestBudgets(conn: Conn, takeHome: number, keep: number): Promise<Record<string, number>> {
  const avg = Object.fromEntries(Object.entries(await averages(conn)).filter(([, a]) => a >= 5));
  const spendable = Math.max(0.0, takeHome - keep - await committedTotal(conn));
  if (!Object.keys(avg).length) return {};
  if (sum(Object.values(avg)) <= spendable) return Object.fromEntries(Object.entries(avg).map(([c, a]) => [c, round10(a)]));
  const total = (f: number) => sum(Object.entries(avg).map(([c, a]) => a * Math.max(0.2, 1 - f * (DISCRETIONARY[c] ?? 0.7))));
  let lo = 0.0, hi = 5.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) > spendable) lo = mid; else hi = mid;
  }
  return Object.fromEntries(Object.entries(avg).map(([c, a]) => [c, round10(a * Math.max(0.2, 1 - hi * (DISCRETIONARY[c] ?? 0.7)))]));
}

export const getPlan = (conn: Conn) => db.getMeta<any>(conn, "plan");

/** The habit-based split, scaled so it adds up to exactly what's free to spend. */
export async function autoBudgets(conn: Conn, takeHome: number, keep: number): Promise<Record<string, number>> {
  const split = await suggestBudgets(conn, takeHome, keep);
  const spendable = Math.max(0.0, takeHome - keep - await committedTotal(conn));
  const total = sum(Object.values(split));
  if (!Object.keys(split).length || !total || !spendable) return {};
  const out: Record<string, number> = Object.fromEntries(Object.entries(split).map(([c, v]) => [c, pyRound(v * spendable / total)]));
  const biggest = maxBy(Object.keys(out), (c) => out[c])!;
  out[biggest] += pyRound(spendable - sum(Object.values(out)));  // rounding leftovers go to the biggest
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v > 0));
}

/** split "auto" keeps the budgets following income, savings and fixed costs; "custom" keeps what you typed. Left
 * out, the plan keeps the split it had (plans from before this were custom). */
export async function savePlan(conn: Conn, takeHome: number, keep: number, budgets: Record<string, number> | null,
                               split: string | null = null): Promise<Row> {
  const current = (await getPlan(conn)) || {};
  split = split || current.split || (budgets == null ? "auto" : "custom");
  if (split === "auto") budgets = await autoBudgets(conn, takeHome, keep);
  const chosen: Record<string, number> = (budgets && Object.keys(budgets).length ? budgets : null) || current.budgets || {};
  const plan = {
    take_home: takeHome, keep, split,
    budgets: Object.fromEntries(Object.entries(chosen).filter(([c, v]) => SPENDING.has(c) && v > 0).map(([c, v]) => [c, Number(v)])),
    limits: current.limits ?? {},
  };
  await db.setMeta(conn, "plan", plan);
  return plan;
}

/** After fixed costs change, an automatic split follows them. */
export async function resplit(conn: Conn) {
  const plan = await getPlan(conn);
  if (plan && plan.split === "auto") await savePlan(conn, plan.take_home, plan.keep, null, "auto");
}

/** After the first import, set the plan up from what the transactions show: pay and payday from the salary
 * deposits, savings from what has actually gone into savings accounts, and an automatic split. Does nothing once a
 * plan exists. Settings records it so the app can say so once. */
export async function autofill(conn: Conn): Promise<boolean> {
  if (await getPlan(conn)) return false;
  const pay = await detectPayday(conn);
  if (!pay) return false;
  const habits = await import("./habits.js");
  const day: Payday = pay.day <= 28 ? pay.day : "last";
  await db.setMeta(conn, "settings", { ...((await db.getMeta<any>(conn, "settings")) || {}), payday: day, autofilled: true });
  setPayday(day);
  const takeHome = pyRound(pay.amount);
  const ids = await habits.savingsAccountIds(conn);
  let keep = 0.0;
  if (ids.length) {
    // What goes into savings each month. Money comes back out between paydays, so the net swings wildly; the
    // typical amount moved in is what you mean to put aside.
    const moved: number[] = [];
    for (let i = 1; i < 4; i++) {
      const [ms, me] = monthBounds(shift(thisMonth(), -i));
      moved.push(first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account IN (${ids.map(() => "?").join(",")})
                                   AND amount > 0 AND date >= ? AND date < ? AND duplicate_of IS NULL AND currency = 'EUR'`,
        [...ids, ms, me])).one()));
    }
    keep = Math.max(0.0, roundTo(median(moved), 50));
  }
  if (keep + await committedTotal(conn) >= takeHome) keep = 0.0;
  await savePlan(conn, takeHome, keep, null, "auto");
  return true;
}

/** The budgets that apply to a pay month. The plan's budgets are the goal; a month can carry a working limit on the
 * way down to it, which scales every budget in proportion. */
export function budgetsFor(plan: Row | null, month: string): Record<string, number> {
  if (!plan) return {};
  const goal = sum(Object.values<number>(plan.budgets));
  const limit = (plan.limits || {})[month];
  if (!limit || !goal) return { ...plan.budgets };
  const scaled: Record<string, number> = Object.fromEntries(Object.entries<number>(plan.budgets).map(([c, v]) => [c, pyRound(v * limit / goal, 2)]));
  // Rounding each budget drifts by cents; the biggest absorbs it, so they add up to the limit you set.
  const drift = pyRound(limit - sum(Object.values(scaled)), 2);
  if (drift && Object.keys(scaled).length) {
    const biggest = maxBy(Object.keys(scaled), (c) => [scaled[c], c])!;
    scaled[biggest] = pyRound(scaled[biggest] + drift, 2);
  }
  return scaled;
}

export async function setLimit(conn: Conn, month: string, limit: number): Promise<Row> {
  const plan = await getPlan(conn);
  plan.limits = plan.limits || {};
  plan.limits[month] = Number(limit);
  await db.setMeta(conn, "plan", plan);
  return plan;
}

export async function planView(conn: Conn): Promise<Row> {
  const plan = await getPlan(conn);
  const avg = await averages(conn);
  if (!plan) return { plan: null, averages: avg };
  return { plan, averages: avg, total: sum(Object.values<number>(plan.budgets)) };
}

// ---------- pace ----------

async function categoryRows(conn: Conn, start: string, end: string): Promise<Map<string, { spent: number; count: number }>> {
  const rows = (await conn.execute(`
    SELECT category, -SUM(amount) AS spent, COUNT(*) FILTER (WHERE amount < 0) AS count FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows;
  return new Map(rows.map((r) => [r.category, { spent: pyRound(r.spent, 2), count: r.count }]));
}

/** The habit behind a number, in plain words. */
export function habit(category: string, spent: number, count: number, budget: number | null | undefined, elapsed: number): string {
  const weeks = Math.max(1.0, elapsed / 7);
  const per = count ? spent / count : 0;
  const plan = budget ? ` Plan was €${fmt0(budget)}.` : "";
  if (category === "delivery") return `${count} orders, about ${fmt0(count / weeks, false)} a week.${plan}`;
  if (category === "eating_out" || category === "coffee_bars") {
    const word = category === "eating_out" ? "meals" : "visits";
    return `${count} ${word}, €${fmt0(per)} each.${plan}`;
  }
  if (category === "cash") return `${count} withdrawals, €${fmt0(per)} each.${plan}`;
  return `${count} payments, €${fmt0(per)} on average.${plan}`;
}

export async function pace(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const [elapsed, days] = dayProgress(month);
  const plan = await getPlan(conn);
  const budgets = budgetsFor(plan, month);
  const rows = await categoryRows(conn, start, end);
  const total = pyRound(sum([...rows.values()].map((r) => r.spent)), 2);
  const planned = plan ? pyRound(sum(Object.values(budgets)), 2) : null;
  const expected = planned ? planned * elapsed / days : null;

  const categories = [];
  // Ties (nothing spent yet) by name: a set's order changes from one process to the next.
  const all = new Set([...rows.keys(), ...Object.keys(budgets)]);
  for (const cat of sorted(all, (c) => [-(rows.get(c)?.spent ?? 0), c])) {
    const r = rows.get(cat) ?? { spent: 0.0, count: 0 };
    const budget = budgets[cat];
    let status = "none";
    if (budget) {
      if (r.spent > budget) status = "over";
      else if (elapsed && r.spent > budget * elapsed / days * 1.15 && r.spent - budget * elapsed / days > 25) status = "ahead";
      else status = "fine";
    }
    categories.push({
      category: cat, spent: r.spent, count: r.count, budget: budget ?? null, status,
      habit: r.count ? habit(cat, r.spent, r.count, budget, elapsed) : "",
    });
  }
  const projected = elapsed && month === thisMonth() ? pyRound(total / elapsed * days, 2) : total;
  return {
    month, start, end, elapsed, days, total, planned,
    expected_to_date: expected != null ? pyRound(expected, 2) : null,
    projected, take_home: plan?.take_home ?? null,
    categories,
  };
}

// ---------- category detail ----------

export async function categoryDetail(conn: Conn, category: string, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const services = new Map<string, { amount: number; count: number; accounts: Set<string> }>();
  for (const r of await conn.execute(`
    SELECT t.amount, t.merchant, t.description, t.mcc, a.name AS account, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.date < ? AND t.category = ? AND t.currency = 'EUR'
      AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
  `, [start, end, category])) {
    const name = sn(r);
    if (!services.has(name)) services.set(name, { amount: 0.0, count: 0, accounts: new Set() });
    const s = services.get(name)!;
    s.amount -= r.amount; s.count += 1; s.accounts.add(r.account);
  }
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const m = shift(month, -i);
    const [ms, me] = monthBounds(m);
    const v = first((await conn.execute("SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND category = ? AND currency = 'EUR' AND duplicate_of IS NULL AND commitment_id IS NULL",
      [ms, me, category])).one());
    history.push({ month: m, spent: pyRound(v, 2) });
  }
  const budget = budgetsFor(await getPlan(conn), month)[category] ?? null;
  return {
    category, month, budget, history,
    spent: pyRound(sum([...services.values()].map((s) => s.amount)), 2),
    services: sorted([...services.entries()].filter(([, s]) => s.amount > 0).map(([n, s]) => ({
      name: n, amount: pyRound(s.amount, 2), count: s.count, accounts: sorted(s.accounts),
    })), (s) => -s.amount),
  };
}

// ---------- subscriptions ----------

/** Services charged in at least 3 of the last 6 months, with a steady-ish monthly cost. */
export async function subscriptions(conn: Conn): Promise<Row> {
  const since = monthBounds(shift(thisMonth(), -6))[0];
  const byService = new Map<string, Map<string, number>>();
  const last = new Map<string, string>();
  for (const r of await conn.execute(`
    SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account
    WHERE t.date >= ? AND t.currency = 'EUR' AND t.amount < 0 AND t.duplicate_of IS NULL
      AND t.category IN ('subscriptions', 'bills', 'health', 'leisure', 'insurance', 'loans', 'education')
  `, [since])) {
    if (r.is_card && !r.merchant) continue;  // card rows have no name, so they can't be told apart as services
    const name = serviceName(r.merchant, r.description, false, r.mcc);
    if (!byService.has(name)) byService.set(name, new Map());
    const months = byService.get(name)!, m = monthOf(r.date);
    months.set(m, (months.get(m) ?? 0) - r.amount);
    last.set(name, (last.get(name) ?? "") > r.date ? last.get(name)! : r.date);
  }
  const today = clock.serverToday();
  const items = [];
  for (const [name, months] of byService) {
    if (months.size < 3) continue;
    const recent = sorted(months.keys()).slice(-3).map((m) => months.get(m)!);
    const monthly = pyRound(median(recent), 2);
    const lastCharge = PyDate.fromisoformat(last.get(name)!);
    const stale = today.diffDays(lastCharge) > 45;
    items.push({
      name, monthly, months: months.size, last_charge: last.get(name)!,
      next_charge: stale ? null : lastCharge.addDays(30).isoformat(),
      varies: Math.max(...recent) - Math.min(...recent) > Math.max(2.0, monthly * 0.15), stale,
    });
  }
  const ordered = sorted(items, (s) => [s.stale ? 1 : 0, -s.monthly]);
  const active = ordered.filter((s) => !s.stale);
  const monthly = pyRound(sum(active.map((s) => s.monthly)), 2);
  return { items: ordered, monthly, yearly: pyRound(monthly * 12, 2), count: active.length };
}

// ---------- year ----------

export async function year(conn: Conn, y: number): Promise<Row> {
  const start = monthBounds(`${y}-01`)[0], end = monthBounds(`${y}-12`)[1];
  const months = await monthsSpent(conn, start, end);
  const cats = (await conn.execute(`
    SELECT category, -SUM(amount) AS spent, COUNT(*) AS count FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category HAVING -SUM(amount) > 0 ORDER BY spent DESC
  `, [start, end, ...SPEND_ARGS])).rows;
  const total = pyRound(sum(months.map((m) => m.spent)), 2);
  const plan = await getPlan(conn);
  const monthlyPlan = plan ? sum(Object.values<number>(plan.budgets)) : null;
  const peak = months.length ? maxBy(months, (m) => m.spent)! : null;
  let peakCat = null;
  if (peak) {
    const [ps, pe] = monthBounds(peak.month);
    peakCat = (await conn.execute(`
      SELECT category, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL}
      GROUP BY category ORDER BY spent DESC LIMIT 1
    `, [ps, pe, ...SPEND_ARGS])).one() ?? null;
  }
  const under = months.filter((m) => monthlyPlan && m.spent <= monthlyPlan).map((m) => m.month);
  const committed = first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ? AND ${COMMITTED_SQL}`,
    [start, end])).one());
  return {
    year: y, total, months, categories: cats,
    monthly_average: months.length ? pyRound(total / months.length, 2) : 0,
    monthly_plan: monthlyPlan, peak, peak_category: peakCat, under_plan: under,
    committed: pyRound(committed, 2),
    years: (await conn.execute("SELECT DISTINCT substr(date, 1, 4) FROM transactions ORDER BY 1")).rows.map(first),
  };
}

/** Free spending per pay month between two days, oldest first. */
async function monthsSpent(conn: Conn, start: string, end: string): Promise<{ month: string; spent: number }[]> {
  const by = new Map<string, number>();
  for (const r of await conn.execute(`SELECT date, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY date`,
    [start, end, ...SPEND_ARGS])) {
    const m = monthOf(r.date);
    by.set(m, (by.get(m) ?? 0) + r.spent);
  }
  return sorted(by.entries(), ([m]) => m).map(([m, v]) => ({ month: m, spent: pyRound(v, 2) }));
}

// ---------- goals ----------

export async function goalView(conn: Conn, goal: Row): Promise<Row> {
  const remaining = Math.max(0.0, goal.price - goal.saved);
  const days = Math.max(1, PyDate.fromisoformat(goal.target_date).diffDays(clock.serverToday()));
  const weekly = remaining / (days / 7);
  const monthly = remaining / (days / 30.44);
  return {
    ...goal, remaining: pyRound(remaining, 2), weeks_left: Math.max(1, pyRound(days / 7)),
    weekly: pyRound(weekly, 2), monthly: pyRound(monthly, 2), cuts: await cuts(conn, monthly),
  };
}

/** Concrete changes from your last 3 months, biggest first, until they cover the goal. */
export async function cuts(conn: Conn, neededMonthly: number): Promise<Row[]> {
  const start = monthBounds(shift(thisMonth(), -3))[0];
  const end = monthBounds(thisMonth())[0];
  const stats = new Map((await conn.execute(`
    SELECT category, -SUM(amount) / 3.0 AS monthly, COUNT(*) FILTER (WHERE amount < 0) / 3.0 AS per_month,
           -SUM(amount) / GREATEST(1, COUNT(*) FILTER (WHERE amount < 0)) AS avg FROM transactions
    WHERE date >= ? AND date < ? AND ${SPEND_SQL} GROUP BY category
  `, [start, end, ...SPEND_ARGS])).rows.map((r) => [r.category, r]));
  const options: Row[] = [];
  const d = stats.get("delivery"), e = stats.get("eating_out"), c = stats.get("coffee_bars"), s = stats.get("shopping"), x = stats.get("cash");
  if (d && d.per_month >= 4) options.push({ category: "delivery", text: "1 fewer delivery a week", detail: `you average €${fmt0(d.avg)} an order`, monthly: pyRound(d.avg * 4.33, 2) });
  if (e && e.per_month >= 4) options.push({ category: "eating_out", text: "Eat out 3 fewer times a month", detail: `€${fmt0(e.avg)} a meal`, monthly: pyRound(e.avg * 3, 2) });
  if (c && c.per_month >= 6) options.push({ category: "coffee_bars", text: "Skip a third of coffee and bar visits", detail: `€${fmt0(c.avg)} a visit`, monthly: pyRound(c.monthly / 3, 2) });
  if (s && s.monthly >= 100) options.push({ category: "shopping", text: "Cut shopping by a quarter", detail: `usually €${fmt0(s.monthly)} a month`, monthly: pyRound(s.monthly / 4, 2) });
  if (x && x.monthly >= 200) options.push({ category: "cash", text: "Withdraw €50 less cash a week", detail: `usually €${fmt0(x.monthly)} a month in cash`, monthly: pyRound(50 * 4.33, 2) });
  const subs = await subscriptions(conn);
  for (const sub of subs.items.filter((t: Row) => !t.stale && t.monthly >= 8).slice(0, 2)) {
    options.push({ category: "subscriptions", text: `Pause ${sub.name} until then`, detail: "charged monthly", monthly: sub.monthly });
  }
  // Small, specific habits first (they stick); the blunt levers only if those aren't enough.
  const order = ["delivery", "eating_out", "subscriptions", "coffee_bars", "shopping", "cash"];
  const chosen: Row[] = [];
  let total = 0.0;
  for (const o of sorted(options, (o) => [order.indexOf(o.category), -o.monthly])) {
    if (total >= neededMonthly && chosen.length >= 2) break;
    chosen.push(o);
    total += o.monthly;
  }
  return chosen;
}

// ---------- day / week / month for the Home card ----------

/** Spending from start up to and including end. */
export async function spentBetween(conn: Conn, start: PyDate, end: PyDate): Promise<number> {
  const row = (await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date <= ? AND ${SPEND_SQL}`,
    [start.isoformat(), end.isoformat(), ...SPEND_ARGS])).one();
  return pyRound(first(row), 2);
}

/** This pay month so far, for Today: each day's spending, the average day, where the month ends at that pace,
 * and where the money went. Everything counts the same days (the start of the month up to and including today),
 * so the totals agree. */
export async function todayView(conn: Conn): Promise<Row> {
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const length = end.diffDays(firstDay);
  const byDay = new Map((await conn.execute(
    `SELECT date, -SUM(amount) AS spent FROM transactions WHERE date >= ? AND date <= ? AND ${SPEND_SQL} GROUP BY date`,
    [firstDay.isoformat(), today.isoformat(), ...SPEND_ARGS])).rows.map((r) => [r.date, pyRound(r.spent, 2)]));
  const days = Array.from({ length }, (_, i) => firstDay.addDays(i)).map((d) => ({
    date: d.isoformat(), spent: d.n <= today.n ? (byDay.get(d.isoformat()) ?? 0.0) : null,
  }));
  const spent = pyRound(sum(byDay.values()), 2);
  const elapsed = today.diffDays(firstDay) + 1;
  const rows = await categoryRows(conn, firstDay.isoformat(), today.addDays(1).isoformat());
  const categories = sorted([...rows.entries()].filter(([, r]) => r.spent > 0).map(([c, r]) => ({ category: c, ...r })), (c) => -c.spent);
  return {
    month, start: firstDay.isoformat(), end: end.isoformat(), today: today.isoformat(),
    length, elapsed, spent, days,
    average: pyRound(spent / elapsed, 2), projected: pyRound(spent / elapsed * length, 2),
    categories, ideal: await ideal(conn, length),
  };
}

/** What the month should look like: income less savings, fixed costs and what each goal needs a month, shared
 * over the days and across categories in the plan's proportions. */
async function ideal(conn: Conn, length: number): Promise<Row | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const goals = [];
  for (const r of await conn.execute("SELECT name, price, saved, target_date FROM goals ORDER BY target_date")) {
    const daysLeft = Math.max(1, PyDate.fromisoformat(r.target_date).diffDays(localToday()));
    goals.push({ name: r.name, price: r.price, target_date: r.target_date, monthly: pyRound(Math.max(0.0, r.price - r.saved) / (daysLeft / 30.44), 2) });
  }
  const fixed = await committedTotal(conn);
  const budget = Math.max(0.0, plan.take_home - plan.keep - fixed - sum(goals.map((g) => g.monthly)));
  const shares: Record<string, number> = plan.budgets;
  const total = sum(Object.values(shares));
  return {
    income: plan.take_home, savings: plan.keep, fixed, goals,
    budget: pyRound(budget, 2), day: pyRound(budget / length, 2),
    targets: total ? Object.fromEntries(Object.entries(shares).map(([c, v]) => [c, pyRound(v * budget / total, 2)])) : {},
  };
}

/**
 * What's left today, this week and this month. None without a plan.
 *
 * Day: what's left of the month shared over the days to go (today included) - mode "share". When that's out of
 * reach (the plan is used up, or staying on it would take under 60% of the recent daily pace) a plan day would just
 * be ignored, so mode "catch_up" sets a realistic day instead: three quarters of the recent pace, never below a plan
 * day, never above the pace itself. finish is where the month lands at that rate, and suggest_limit offers a working
 * limit for next month on the way back down to the plan (or for this month, early in it, after a bad one).
 * Week: Monday to Sunday, limit = a normal plan day x 7.
 * Month: every day's spending so far (None for days still to come), for the day strip.
 */
export async function periods(conn: Conn): Promise<Row | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const days = end.diffDays(firstDay);
  const goal = sum(Object.values<number>(plan.budgets));
  const monthly = sum(Object.values(budgetsFor(plan, month)));
  const perDay = monthly / days;
  const monthSpent = await spentBetween(conn, firstDay, end.addDays(-1));
  const beforeToday = today.n > firstDay.n ? await spentBetween(conn, firstDay, today.addDays(-1)) : 0.0;
  const todaySpent = await spentBetween(conn, today, today);
  const daysLeft = end.diffDays(today);
  const leftForMonth = monthly - beforeToday;
  const gone = today.diffDays(firstDay);
  const paceDaily = gone >= 3 ? beforeToday / gone : null;
  const need = leftForMonth / daysLeft;
  let dayLimit: number, mode: string;
  if (paceDaily && (need <= 0 || need < 0.6 * paceDaily) && paceDaily > perDay) {
    dayLimit = Math.min(paceDaily, Math.max(perDay, need, roundTo(0.75 * paceDaily, 5))); mode = "catch_up";
  } else if (need > 0) {
    dayLimit = need; mode = "share";
  } else {
    dayLimit = perDay; mode = "catch_up";
  }
  const finish = beforeToday + dayLimit * daysLeft;

  const limits = plan.limits || {};
  let suggest: Row | null = null;
  if (mode === "catch_up" && !(shift(month, 1) in limits)) {
    suggest = { month: shift(month, 1), limit: Math.max(goal, roundTo(0.9 * finish, 50)), goal };
  } else if (!(month in limits) && gone <= 5) {
    const [ps, pe] = monthBounds(shift(month, -1));
    const last = await spentBetween(conn, PyDate.fromisoformat(ps), PyDate.fromisoformat(pe).addDays(-1));
    if (last > goal * 1.05) suggest = { month, limit: Math.max(goal, roundTo(0.9 * last, 50)), goal, last };
  }

  const monday = today.addDays(-today.weekday());
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = monday.addDays(i);
    weekDays.push({ date: d.isoformat(), spent: d.n <= today.n ? await spentBetween(conn, d, d) : null });
  }
  const weekSpent = pyRound(sum(weekDays.map((d) => d.spent || 0)), 2);
  const monthDaysList = [];
  for (let i = 0; i < days; i++) {
    const d = firstDay.addDays(i);
    monthDaysList.push({ date: d.isoformat(), spent: d.n <= today.n ? await spentBetween(conn, d, d) : null });
  }
  return {
    today: today.isoformat(),
    day: {
      spent: todaySpent, limit: pyRound(dayLimit, 2), mode, days_left: daysLeft,
      left_for_month: pyRound(leftForMonth, 2), pace: paceDaily ? pyRound(paceDaily, 2) : null, finish: pyRound(finish, 2),
    },
    week: { spent: weekSpent, limit: pyRound(perDay * 7, 2), daily_limit: pyRound(perDay, 2), start: monday.isoformat(), days: weekDays },
    month: { key: month, spent: monthSpent, limit: pyRound(monthly, 2), goal, days_left: daysLeft - 1, daily_limit: pyRound(perDay, 2), days: monthDaysList },
    suggest_limit: suggest,
  };
}

// ---------- service level (Period -> Group -> Service -> Transactions) ----------

async function serviceRows(conn: Conn, category: string, name: string, start?: string | null, end?: string | null): Promise<Row[]> {
  const where = ["t.category = ?", "t.currency = 'EUR'", "t.duplicate_of IS NULL", "t.commitment_id IS NULL"];
  const args: unknown[] = [category];
  if (start) { where.push("t.date >= ?"); args.push(start); }
  if (end) { where.push("t.date < ?"); args.push(end); }
  const rows = (await conn.execute(`
    SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE ${where.join(" AND ")}
  `, args)).rows;
  return rows.filter((r) => sn(r) === name);
}

export async function serviceDetail(conn: Conn, category: string, name: string, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const rows = await serviceRows(conn, category, name, start, end);
  const spent = pyRound(-sum(rows.map((r) => r.amount)), 2);
  const count = rows.filter((r) => r.amount < 0).length;
  const categoryTotal = first((await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND category = ? AND currency = 'EUR' AND duplicate_of IS NULL AND commitment_id IS NULL`, [start, end, category])).one());
  const weekdays = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
  const perDay = new Map<string, number>();
  for (const r of rows) {
    weekdays[PyDate.fromisoformat(r.date).weekday()] += -r.amount;
    if (r.amount < 0) perDay.set(r.date, (perDay.get(r.date) ?? 0) + 1);
  }
  const busiest = sorted([...perDay.entries()].filter(([, n]) => n >= 3).map(([d, n]) => [n, d] as [number, string]), (x) => x, true).slice(0, 2);
  const histFirst = monthBounds(shift(month, -5))[0];
  const histRows = await serviceRows(conn, category, name, histFirst, end);
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const m = shift(month, -i);
    history.push({ month: m, spent: pyRound(-sum(histRows.filter((r) => r.date.startsWith(m)).map((r) => r.amount)), 2) });
  }
  return {
    category, name, month, spent, count,
    average: count ? pyRound(spent / count, 2) : 0,
    share: categoryTotal > 0 ? pyRound(spent / categoryTotal, 3) : null,
    history, weekdays: weekdays.map((v) => pyRound(v, 2)),
    busiest_days: sorted(busiest, (x) => x[1]).map(([n, d]) => ({ date: d, count: n })),
  };
}

export async function serviceTransactionIds(conn: Conn, category: string, name: string): Promise<string[]> {
  return (await serviceRows(conn, category, name)).map((r) => r.id);
}

// ---------- commitments: fixed and chosen costs, kept apart from free spending ----------

async function commitmentRows(conn: Conn): Promise<Row[]> {
  const out = [];
  for (const r of await conn.execute("SELECT * FROM commitments ORDER BY kind, name")) {
    const c: Row = { ...r, services: JSON.parse(r.services) };
    if (c.every_months > 1) Object.assign(c, cycle(c));
    out.push(c);
  }
  return out;
}

function addMonths(d: PyDate, n: number): PyDate {
  const i = d.month - 1 + n;
  const y = d.year + Math.floor(i / 12), m = pyMod(i, 12) + 1;
  return new PyDate(y, m, Math.min(d.day, monthDays(y, m)));
}

/** For a cost paid every few months: the next payment (moved on once its date has passed), and what should be put
 * aside towards it by now, a monthly share at a time since the last one. */
function cycle(c: Row): Row {
  const today = localToday();
  let nxt = c.next_date ? PyDate.fromisoformat(c.next_date) : addMonths(today, c.every_months);
  while (nxt.n < today.n) nxt = addMonths(nxt, c.every_months);
  const last = addMonths(nxt, -c.every_months);
  const whole = (today.year - last.year) * 12 + today.month - last.month - (today.day < last.day ? 1 : 0);
  const months = Math.max(0, Math.min(c.every_months, whole));
  const amount = c.amount || c.monthly_limit * c.every_months;
  return { next_date: nxt.isoformat(), last_date: last.isoformat(), amount, set_aside: pyRound(Math.min(amount, c.monthly_limit * months), 2) };
}

/** Monthly limits of all commitments: what the plan sets aside before free spending. */
export async function committedTotal(conn: Conn): Promise<number> {
  return pyRound(sum((await commitmentRows(conn)).map((c) => c.monthly_limit)), 2);
}

/** Tags each transaction with the commitment its service belongs to (or none). */
export async function assignCommitments(conn: Conn) {
  const byService = new Map<string, number>();
  for (const c of await commitmentRows(conn)) for (const s of c.services) byService.set(s, c.id);
  await conn.execute("UPDATE transactions SET commitment_id = NULL WHERE commitment_id IS NOT NULL");
  if (!byService.size) return;
  for (const r of (await conn.execute(`SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                       JOIN accounts a ON a.id = t.account WHERE t.amount < 0 OR t.amount > 0`)).rows) {
    const cid = byService.get(sn(r));
    if (cid) await conn.execute("UPDATE transactions SET commitment_id = ? WHERE id = ?", [cid, r.id]);
  }
}

async function committedSpent(conn: Conn, cid: number, start: string, end: string): Promise<number> {
  const row = (await conn.execute(`SELECT -COALESCE(SUM(amount), 0) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND ${COMMITTED_SQL}`,
    [cid, start, end])).one();
  return pyRound(first(row), 2);
}

export async function commitmentsView(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const items: Row[] = [];
  for (const c of await commitmentRows(conn)) {
    const spent = await committedSpent(conn, c.id, start, end) + c.off_bank;
    const history = [];
    for (let i = 5; i >= 0; i--) {
      const m = shift(month, -i);
      const [ms, me] = monthBounds(m);
      history.push({ month: m, spent: pyRound(await committedSpent(conn, c.id, ms, me) + c.off_bank, 2) });
    }
    const count = first((await conn.execute(`SELECT COUNT(*) FROM transactions WHERE commitment_id = ? AND date >= ? AND date < ? AND amount < 0 AND ${COMMITTED_SQL}`,
      [c.id, start, end])).one());
    // A cost paid every few months is over only when a payment goes past its amount, not its monthly share.
    const cap = c.every_months > 1 ? c.amount : c.monthly_limit;
    items.push({ ...c, spent: pyRound(spent, 2), count, over: spent > cap + 0.005, history });
  }
  const taken = new Set(items.flatMap((c) => c.services));
  const suggestions = new Map<string, number>();
  for (const s of (await subscriptions(conn)).items) {
    if (!s.stale && !taken.has(s.name)) suggestions.set(s.name, s.monthly);
  }
  for (const s of await servicesSeen(conn)) {
    if (s.months >= 4 && COMMITTABLE.has(s.category) && s.monthly >= 10 && !s.service.startsWith("Card · ") && !taken.has(s.service)) {
      // servicesSeen averages over 6 months; use the typical active month instead
      if (!suggestions.has(s.service)) suggestions.set(s.service, pyRound(s.monthly * 6 / s.months, 2));
    }
  }
  const list = sorted(suggestions.entries(), ([, m]) => -m).filter(([, m]) => m >= 2)
    .map(([n, m]) => ({ service: n, monthly: m, limit: Math.max(10, -Math.floor(-m * 1.1 / 10) * 10) }));
  return {
    month, items, suggestions: list,
    limit: pyRound(sum(items.map((c) => c.monthly_limit)), 2),
    spent: pyRound(sum(items.map((c) => c.spent)), 2),
    over: items.filter((c) => c.over).map((c) => c.name),
  };
}

/** Every service with spending in the last months, for picking what a commitment covers. transfers: also big
 * transfers, since rent paid ahead usually leaves as one. */
export async function servicesSeen(conn: Conn, months = 6, transfers = false): Promise<Row[]> {
  const since = monthBounds(shift(thisMonth(), -months))[0];
  const totals = new Map<string, { amount: number; months: Set<string>; cats: Map<string, number> }>();
  for (const r of await conn.execute(`SELECT t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card FROM transactions t
    JOIN accounts a ON a.id = t.account WHERE t.date >= ? AND t.amount < 0 AND t.duplicate_of IS NULL AND t.currency = 'EUR'
      AND (t.category NOT IN ('transfer', 'card_payment', 'income') OR (?::boolean AND t.category = 'transfer' AND t.amount <= -300))`,
    [since, transfers])) {
    const n = sn(r);
    if (!totals.has(n)) totals.set(n, { amount: 0.0, months: new Set(), cats: new Map() });
    const t = totals.get(n)!;
    t.amount -= r.amount;
    t.months.add(monthOf(r.date));
    t.cats.set(r.category, (t.cats.get(r.category) ?? 0) + 1);
  }
  return sorted([...totals.entries()].filter(([, v]) => v.amount > 0).map(([n, v]) => ({
    service: n, monthly: pyRound(v.amount / months, 2), months: v.months.size,
    category: maxBy(v.cats.keys(), (c) => v.cats.get(c)!)!,
  })), (x) => -x.monthly);
}

// Habits stay out of suggestions: those are what the plan is for, not commitments.
export const COMMITTABLE = new Set(["bills", "subscriptions", "health", "housing", "eating_out", "leisure", "personal_care", "pets", "fees",
  "loans", "insurance", "education", "kids"]);

// ---------- cash entries: spending logged by hand, taken out of withdrawals ----------

export { CASH_ACCOUNT };

/** Withdrawn this month vs what has been logged against it. */
export async function cashView(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const withdrawn = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND category = 'cash' AND account != ? AND amount < 0 AND duplicate_of IS NULL AND currency = 'EUR'`, [start, end, CASH_ACCOUNT])).one());
  const logged = -first((await conn.execute(`SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE date >= ? AND date < ?
    AND account = ? AND status = 'CASH' AND amount < 0`, [start, end, CASH_ACCOUNT])).one());
  return { withdrawn: pyRound(withdrawn, 2), logged: pyRound(logged, 2), unaccounted: pyRound(Math.max(0, withdrawn - logged), 2) };
}

/** Records cash spending. Two rows: the spending in its category, and an equal credit in Cash, so the withdrawal
 * (already counted as Cash) shrinks by the same amount and the month's total doesn't change. */
export async function logCash(conn: Conn, amount: number, category: string, note: string, day: string): Promise<string> {
  await conn.execute(`INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, NULL, 'Cash', 0, NULL, 'Cash')
                      ON CONFLICT(user_id, id) DO NOTHING`, [CASH_ACCOUNT]);
  const key = randomBytes(6).toString("hex");
  note = note.trim() || CATEGORIES[category][0];
  const raw = pyDumps({ logged_by_hand: true, note });
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
                      VALUES(?, ?, ?, ?, 'EUR', 'CASH', ?, ?, NULL, ?, ?)`,
    [`cash:${key}`, CASH_ACCOUNT, day, -Math.abs(amount), `Cash: ${note}`, `Cash: ${note}`, category, raw]);
  // The offset never shows in lists (status OFFSET); it only reduces Cash.
  await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw, duplicate_of)
                      VALUES(?, ?, ?, ?, 'EUR', 'OFFSET', ?, '', NULL, 'cash', ?, NULL)`,
    [`cash:${key}:offset`, CASH_ACCOUNT, day, Math.abs(amount), `Logged from cash: ${note}`, raw]);
  return `cash:${key}`;
}

// ---------- questions the assistant asks: payments it couldn't place ----------

/** One question per payee left in Other over the last 90 days, biggest first. */
export async function questions(conn: Conn, limit = 10): Promise<Row[]> {
  const since = localToday().addDays(-90).isoformat();
  const rows = (await conn.execute(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card, a.name AS account
    FROM transactions t JOIN accounts a ON a.id = t.account
    WHERE t.category = 'other' AND t.amount < 0 AND t.date >= ? AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
      AND t.status != 'OFFSET' ORDER BY t.amount`, [since])).rows;
  const out = new Map<string, Row>();
  for (const r of rows) {
    const n = sn(r);
    if (!out.has(n)) out.set(n, { service: n, tx_id: r.id, count: 0, amount: 0.0, date: r.date, account: r.account, has_merchant: Boolean(r.merchant) });
    const q = out.get(n)!;
    q.count += 1;
    q.amount = pyRound(q.amount - r.amount, 2);
  }
  return sorted(out.values(), (q) => -q.amount).slice(0, limit);
}

export async function serviceIdsAnywhere(conn: Conn, name: string): Promise<Row[]> {
  const rows = (await conn.execute(`SELECT t.id, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                    JOIN accounts a ON a.id = t.account WHERE t.status != 'OFFSET'`)).rows;
  return rows.filter((r) => sn(r) === name);
}

/** All payments to a service go to category, now and in future (rules keyed by merchant). */
export async function setServiceCategory(conn: Conn, name: string, category: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) {
    await conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
      [r.merchant || `tx:${r.id}`, category]);
  }
  await db.recategorize(conn);
  return rows.length;
}

/** Undo setServiceCategory: drop the service's rules so its payments go back to being worked out. */
export async function clearServiceCategory(conn: Conn, name: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) await conn.execute("DELETE FROM rules WHERE merchant = ?", [r.merchant || `tx:${r.id}`]);
  await db.recategorize(conn);
  return rows.length;
}

// ---------- extra pay: the Easter, summer and Christmas bonuses of 14 salaries a year ----------

/** Greek Easter: the Julian computus, moved to the Gregorian calendar (13 days, 1900-2099). */
export function orthodoxEaster(y: number): PyDate {
  const a = y % 4, b = y % 7, c = y % 19;
  const d = (19 * c + 15) % 30;
  const e = pyMod(2 * a + 4 * b - d + 34, 7);
  const month = Math.floor((d + e + 114) / 31), day = (d + e + 114) % 31;
  return new PyDate(y, month, day + 1).addDays(13);
}

/** The next three bonuses, soonest first, when 14 salaries is on. Rough amounts from your pay: a month at
 * Christmas, half a month at Easter and in summer. The monthly budget doesn't count on them. */
export async function extraPay(conn: Conn): Promise<Row[]> {
  if (!(await db.getMeta<any>(conn, "settings"))?.extra_pay) return [];
  const plan = await getPlan(conn);
  const pay = plan ? plan.take_home : 0;
  const today = localToday();
  let out: Row[] = [];
  for (const y of [today.year, today.year + 1]) {
    out.push(
      { name: "Easter bonus", amount: pyRound(pay / 2), date: orthodoxEaster(y).addDays(-4).isoformat(), when: "before Easter" },
      { name: "Summer bonus", amount: pyRound(pay / 2), date: new PyDate(y, 6, 30).isoformat(), when: "usually by the end of June" },
      { name: "Christmas bonus", amount: pyRound(pay), date: new PyDate(y, 12, 21).isoformat(), when: "by 21 December" },
    );
  }
  out = sorted(out.filter((b) => b.date >= today.isoformat()), (b) => b.date).slice(0, 3);
  for (const b of out) {
    const d = PyDate.fromisoformat(b.date);
    const day = `${d.day} ${monthName(d)}` + (d.year !== today.year ? ` ${d.year}` : "");
    b.when = ({ "before Easter": `By ${day}, before Easter`, "by 21 December": `By ${day}` } as Record<string, string>)[b.when] ?? `Usually by ${day}`;
  }
  return out;
}


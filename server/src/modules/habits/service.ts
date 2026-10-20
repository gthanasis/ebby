/**
 * The habits on the Goals tab: pay yourself first, no-spend days, the 48-hour rule, yearly costs.
 *
 * They nudge behaviour rather than report it, so each one answers a single question:
 * - Pay yourself first: since payday, has the money you plan to keep reached your savings?
 * - No-spend days: how many days this week had no free spending at all?
 * - 48 hours: is that thing still worth it two days later?
 * - Yearly costs: what to set aside each month so a yearly bill doesn't wreck one month.
 */

import * as clock from "../../shared/clock.js";
import { type Conn, type Row } from "../../shared/db.js";
import * as goalsRepo from "../goals/repo.js";
import * as habitRulesRepo from "./repo.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import * as wishlistRepo from "./wishlist_repo.js";
import * as yearlyCostsRepo from "./yearly_costs_repo.js";
import { fmt0, fmtG, isoUtc, maxBy, parseIso, PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import { CATEGORIES } from "../../shared/categories.js";
import { PAYDAY_MIN } from "../../shared/constants.js";
import type { HabitRule } from "../../types/entities.js";
import { getPlan } from "../plan/service.js";
import { localToday, monthBounds, thisMonth } from "../../shared/months.js";
import { readSettings } from "../../shared/settings.js";
import { accounts, savingsAccountIds } from "../plan/savings.js";
import * as spending from "../spending/service.js";
import { spentBetween } from "../plan/today.js";
import { type Habit, type HabitDetail, type HabitStatus, type HabitWeek, toHabit, toHabitDetail, toWish, toYearlyCost } from "./converters.js";

const WAIT_MS = 48 * 3600 * 1000;

const now = () => clock.now();

// ---------- pay yourself first ----------

export async function lastPayday(conn: Conn): Promise<Row | null> {
  const r = await transactionsRepo.lastPay(conn, PAYDAY_MIN);
  return r ? { date: r.date, amount: pyRound(r.amount, 2) } : null;
}

export async function payYourselfFirst(conn: Conn): Promise<Row> {
  const plan = await getPlan(conn);
  const ids = await savingsAccountIds(conn);
  const payday = await lastPayday(conn);
  const since = payday ? payday.date : monthBounds(thisMonth())[0];
  let saved = 0.0;
  if (ids.length) {
    saved = await transactionsRepo.netInto(conn, ids, since);
  }
  return {
    target: plan ? plan.keep : null, saved: pyRound(saved, 2), since, payday,
    accounts: (await accounts(conn)).map((a) => ({ ...a, selected: ids.includes(a.id) })),
  };
}

// ---------- no-spend days ----------

export async function noSpend(conn: Conn): Promise<Row> {
  const today = localToday();
  const monday = today.addDays(-today.weekday());
  const week = [];
  for (let i = 0; i < 7; i++) {
    const d = monday.addDays(i);
    week.push({ date: d.isoformat(), spent: d.n <= today.n ? await spentBetween(conn, d, d) : null });
  }
  // Today isn't over, so it doesn't count yet (card payments also land a day late).
  const done = week.filter((w) => w.spent != null && w.date < today.isoformat());
  const firstDay = PyDate.fromisoformat(monthBounds(thisMonth())[0]);
  let best = 0, run = 0;
  for (let d = firstDay; d.n < today.n; d = d.addDays(1)) {
    run = (await spentBetween(conn, d, d)) <= 0 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { week, count_week: done.filter((w) => w.spent! <= 0).length, days_done: done.length, best_month: best };
}

// ---------- the 48-hour list ----------

export async function hourlyRate(conn: Conn): Promise<number | null> {
  const plan = await getPlan(conn);
  const hours = (await readSettings(conn)).work_hours;
  return plan && hours ? pyRound(plan.take_home / hours, 2) : null;
}

export async function wishlist(conn: Conn): Promise<Row[]> {
  const rate = await hourlyRate(conn);
  const at = now();
  const out = [];
  for (const r of await wishlistRepo.undecided(conn)) {
    out.push(toWish(r, new Date(parseIso(r.created_at).getTime() + WAIT_MS), at, rate));
  }
  return out;
}

export async function skippedTotal(conn: Conn, sinceDays = 365): Promise<number> {
  const since = isoUtc(new Date(now().getTime() - sinceDays * 86_400_000));
  return pyRound(await wishlistRepo.skippedSince(conn, since), 2);
}

export async function addWish(conn: Conn, name: string, price: number): Promise<number> {
  return wishlistRepo.add(conn, name.trim(), price, isoUtc(now(), "seconds"));
}

export async function decideWish(conn: Conn, wid: number, decision: string) {
  await wishlistRepo.decide(conn, wid, decision, isoUtc(now(), "seconds"));
}

export async function dueReminders(conn: Conn): Promise<Row[]> {
  return (await wishlist(conn)).filter((w) => w.ready && !w.reminded);
}

// ---------- yearly costs (set aside monthly) ----------

export async function yearly(conn: Conn): Promise<Row> {
  const today = localToday();
  const items = (await yearlyCostsRepo.all(conn)).map((y) => toYearlyCost(y, today));
  const taken = new Set(items.map((i) => i.name.toLowerCase()));
  return {
    items, monthly: pyRound(sum(items.map((i) => i.monthly)), 2),
    suggestions: (await yearlySuggestions(conn)).filter((s) => !taken.has(s.name.toLowerCase())),
  };
}

/** Charges that come once a year: insurance and annual fees in the last 15 months. */
export async function yearlySuggestions(conn: Conn): Promise<Row[]> {
  const since = localToday().addDays(-460).isoformat();
  const rows = await transactionsRepo.yearlyCharges(conn, since);
  const groups = new Map<string, { name: string; months: Map<string, number>; dates: string[] }>();
  for (const r of rows) {
    const d: string = r.description;
    const key = d.includes("ΑΣΦΑΛ") || d.includes("ΑSFΑL") || d.includes("ΙΝΤΕRΑΜ") || d.includes("INTERAM") ? "Insurance" : "Annual fees";
    if (!groups.has(key)) groups.set(key, { name: key, months: new Map(), dates: [] });
    const g = groups.get(key)!;
    const m = r.date.slice(0, 7);
    g.months.set(m, (g.months.get(m) ?? 0) - r.amount);
    g.dates.push(r.date);
  }
  return [...groups.values()].map((g) => {
    const lastMonth = sorted(g.months.keys()).at(-1)!;
    return { name: g.name, yearly_amount: pyRound(g.months.get(lastMonth)!, 2), due_month: parseInt(lastMonth.slice(5, 7), 10), last_paid: sorted(g.dates).at(-1) };
  });
}

export async function overview(conn: Conn): Promise<Row> {
  return {
    pay_first: await payYourselfFirst(conn), no_spend: await noSpend(conn),
    wishlist: await wishlist(conn), skipped_year: await skippedTotal(conn), hourly_rate: await hourlyRate(conn),
    yearly: await yearly(conn),
  };
}

// ---------- weekly habits: four kinds of rule, each kept or missed per week ----------
//
// Every habit is one of four types, with the person's own numbers filled in:
// - fewer:      `target` or fewer payments in `category` a week (5 or fewer deliveries)
// - spend_less: under €`target` a week on `category` (under €50 eating out)
// - nospend:    `target` days a week with no free spending at all
// - wait:       buys over €`target` in `category` go through the 48-hour wishlist first
// Weeks run Monday to Sunday. Each finished week is kept or missed, which is what streaks, savings and anything
// game-like later build on.

// The categories "fewer" is suggested for, with what one payment is called.
const NOUNS: Record<string, [string, string]> = {
  delivery: ["delivery", "deliveries"], eating_out: ["meal out", "meals out"], coffee_bars: ["coffee or drink out", "coffees and drinks out"],
};
const WEEKS = 8;

/** A habit worth starting, with why and what it would save a month (null when it's not about money). */
type Suggestion = Pick<HabitRule, "type" | "category" | "target"> & { why: string; monthly: number | null };
const WEEKS_A_MONTH = 4.33;

const mondayOf = (d: PyDate) => d.addDays(-d.weekday());
const catLabel = (c: string | null) => (c && c in CATEGORIES ? CATEGORIES[c][0].toLowerCase() : "spending");
const plural = (r: Pick<HabitRule, "category">) => (NOUNS[r.category ?? ""] ?? [null, `${catLabel(r.category)} payments`])[1];

async function boughtWishes(conn: Conn, a: PyDate, b: PyDate): Promise<number[]> {
  return wishlistRepo.boughtPrices(conn, a.addDays(-7).isoformat(), b.addDays(2).isoformat());
}

type HabitType = "fewer" | "spend_less" | "nospend" | "wait";

/** What sets one type of habit apart: how it's called, what it counts, when a week is kept, what to say. */
interface HabitKind {
  title(r: Pick<HabitRule, "target" | "category">): string;
  /** The habit's number for the days a..b: payments, euros, no-spend days or wishlist skips. */
  measure(conn: Conn, r: HabitRule, a: PyDate, b: PyDate, rows: spending.SpendRow[]): Promise<{ value: number; spent: number | null }>;
  status(n: number, value: number, finished: boolean, daysLeft: number): HabitStatus;
  nudge(r: HabitRule, value: number, st: string, daysLeft: number): string;
  /** It counts money spent in a category, so it has a baseline to save against. */
  tracksMoney: boolean;
}

const inCategory = (r: HabitRule, rows: spending.SpendRow[]) => rows.filter((x) => x.category === r.category);
// A habit with a ceiling: going over it misses the week, staying under keeps it once the week is over.
const underCap = (over: boolean, finished: boolean, atRisk: boolean) => (over ? "missed" : finished ? "kept" : atRisk ? "at_risk" : "on_track");

const HABIT_KINDS: Record<HabitType, HabitKind> = {
  fewer: {
    title: (r) => `${fmtG(r.target)} or fewer ${plural(r)}`,
    measure: async (conn, r, a, b, rows) => {
      const mine = inCategory(r, rows);
      return { value: mine.length, spent: pyRound(sum(mine.map((x) => x.amount)), 2) };
    },
    status: (n, value, finished) => underCap(value > n, finished, value === n),
    nudge: (r, v, st) => (st === "missed" ? `${fmtG(v)} this week, over your ${fmtG(r.target)}.` : `No more ${plural(r)} this week keeps it.`),
    tracksMoney: true,
  },
  spend_less: {
    title: (r) => `Under €${fmt0(r.target)} a week on ${catLabel(r.category)}`,
    measure: async (conn, r, a, b, rows) => {
      const spent = pyRound(sum(inCategory(r, rows).map((x) => x.amount)), 2);
      return { value: spent, spent };
    },
    status: (n, value, finished) => underCap(value > n, finished, value >= n * 0.85),
    nudge: (r, v, st) => (st === "missed" ? `€${fmt0(v)} this week, over your €${fmt0(r.target)}.` : `€${fmt0(r.target - v)} left on ${catLabel(r.category)} this week.`),
    tracksMoney: true,
  },
  nospend: {
    title: (r) => `${fmtG(r.target)} no-spend days`,
    measure: async (conn, r, a, b, rows) => {
      const today = localToday();
      const spentDays = new Set(rows.map((x) => x.date));
      const done = Array.from({ length: b.diffDays(a) + 1 }, (_, i) => a.addDays(i)).filter((d) => d.n < today.n);  // today isn't over
      return { value: done.filter((d) => !spentDays.has(d.isoformat())).length, spent: null };
    },
    status: (n, value, finished, daysLeft) => {
      if (value >= n) return "kept";
      if (finished || value + daysLeft < n) return "missed";
      return value + daysLeft === n ? "at_risk" : "on_track";
    },
    nudge: (r, v, st, daysLeft) => {
      if (st === "missed") return `${fmtG(v)} of ${fmtG(r.target)} no-spend days, with too few days left.`;
      return daysLeft === 1 ? "Spend nothing today to keep it." : `Spend nothing on the ${daysLeft} days left to keep it.`;
    },
    tracksMoney: false,
  },
  wait: {
    title: (r) => `Wait 48 hours over €${fmt0(r.target)}`,
    measure: async (conn, r, a, b, rows) => {
      const wishes = await boughtWishes(conn, a, b);
      let skipped = 0;
      for (const x of inCategory(r, rows)) {
        if (x.amount > r.target) {
          const i = wishes.findIndex((w) => Math.abs(w - x.amount) <= Math.max(5, w * 0.2));
          if (i === -1) skipped += 1; else wishes.splice(i, 1);
        }
      }
      return { value: skipped, spent: null };
    },
    status: (n, value, finished) => underCap(value > 0, finished, false),
    nudge: (r) => `A buy over €${fmt0(r.target)} skipped the wishlist this week.`,
    tracksMoney: false,
  },
};

export const TYPES: string[] = Object.keys(HABIT_KINDS);
// A type this version doesn't know behaves as "wait".
const kindOf = (type: string): HabitKind => (Object.hasOwn(HABIT_KINDS, type) ? HABIT_KINDS[type as HabitType] : HABIT_KINDS.wait);

export function habitTitle(r: Pick<HabitRule, "type" | "target" | "category">): string {
  return kindOf(r.type).title(r);
}

export async function ruleRows(conn: Conn): Promise<HabitRule[]> {
  return habitRulesRepo.all(conn);
}

export async function habitView(conn: Conn, r: HabitRule, detail = false): Promise<Habit | HabitDetail> {
  const today = localToday();
  const monday = mondayOf(today);
  const sunday = monday.addDays(6);
  const created = mondayOf(PyDate.fromisoformat(r.created_at.slice(0, 10)));
  const daysLeft = 7 - today.weekday();  // today included
  const kind = kindOf(r.type);
  const rows = await spending.rows(conn, monday.addDays(-7 * WEEKS), sunday);
  const weeks: HabitWeek[] = [];
  for (let i = WEEKS; i >= 0; i--) {
    const a = monday.addDays(-7 * i), b = a.addDays(6);
    const wk = rows.filter((x) => a.isoformat() <= x.date && x.date <= b.isoformat());
    const m = await kind.measure(conn, r, a, b, wk);
    const finished = i > 0;
    weeks.push({ start: a.isoformat(), ...m, status: kind.status(r.target, m.value, finished, finished ? 0 : daysLeft), counted: a.n >= created.n, current: !finished });
  }
  const current = weeks[weeks.length - 1];
  let streak = 0;
  for (const w of weeks.slice(0, -1).reverse()) {
    if (!w.counted || w.status !== "kept") break;
    streak += 1;
  }
  let saved = 0.0;
  if (kind.tracksMoney && r.baseline) {
    saved = sum(weeks.slice(0, -1).filter((w) => w.counted).map((w) => Math.max(0.0, r.baseline - (w.spent || 0))));
  }
  const habit = toHabit(r, habitTitle(r), current, streak, saved, daysLeft, kind.nudge(r, current.value, current.status, daysLeft));
  if (!detail) return habit;
  const days: HabitDetail["days"] = [];
  for (let i = 0; i < 7; i++) {
    const d = monday.addDays(i);
    if (d.n > today.n) { days.push({ date: d.isoformat(), value: null }); continue; }
    const m = await kind.measure(conn, r, d, d, rows.filter((x) => x.date === d.isoformat()));
    // A no-spend day counts once it's over: 1 kept, 0 spent on; today is still open.
    const value = r.type === "nospend" ? (rows.some((x) => x.date === d.isoformat()) ? 0 : d.n < today.n ? 1 : null) : m.value;
    days.push({ date: d.isoformat(), value });
  }
  const goal = r.goal_id ? await goalsRepo.nameOf(conn, r.goal_id) : null;
  return toHabitDetail(habit, weeks, days, goal ?? null);
}

/** The last WEEKS finished weeks: payments and euros per category, no-spend days, buys over €50. */
async function weeklyStats(conn: Conn): Promise<{ cats: Map<string, [number, number, number[]]>; nospend: number; enough: boolean }> {
  const monday = mondayOf(localToday());
  const a = monday.addDays(-7 * WEEKS);
  const rows = await spending.rows(conn, a, monday.addDays(-1));
  const cats = new Map<string, [number, number, number[]]>();
  for (const x of rows) {
    const c = cats.get(x.category) ?? [0, 0.0, []];
    c[0] += 1; c[1] += x.amount; c[2].push(x.amount);
    cats.set(x.category, c);
  }
  const spentDays = new Set(rows.map((x) => x.date));
  let free = 0;
  for (let i = 0; i < WEEKS * 7; i++) if (!spentDays.has(a.addDays(i).isoformat())) free += 1;
  const start = await transactionsRepo.oldestDay(conn);
  return { cats, nospend: free / WEEKS, enough: Boolean(start) && start! <= a.isoformat() };
}

/** Habits one step better than how you spend now, biggest saving first. Three at most. */
export async function suggestions(conn: Conn, taken: HabitRule[]): Promise<Row[]> {
  const s = await weeklyStats(conn);
  if (!s.enough) return [];
  const used = new Set(taken.map((r) => `${r.type}|${r.category ?? ""}`));
  const usedCats = new Set(taken.filter((r) => r.category).map((r) => r.category));
  const out: Suggestion[] = [];
  for (const cat of ["delivery", "eating_out", "coffee_bars", "shopping"]) {
    if (usedCats.has(cat) || !s.cats.has(cat)) continue;
    const [n, total] = s.cats.get(cat)!;
    const perWeek = n / WEEKS, spendWeek = total / WEEKS;
    const options: Suggestion[] = [];
    if (cat in NOUNS && perWeek >= 3) {
      const target = Math.max(1, pyRound(perWeek) - 1);
      options.push({ type: "fewer", category: cat, target, why: `You have about ${fmt0(perWeek, false)} a week, €${fmt0(total / n)} each.`,
        monthly: pyRound((perWeek - target) * total / n * WEEKS_A_MONTH, 2) });
    }
    if (spendWeek >= 40) {
      const target = Math.max(10, Math.trunc(Math.floor(spendWeek * 0.8 / 10) * 10));
      options.push({ type: "spend_less", category: cat, target, why: `You usually spend about €${fmt0(spendWeek)} a week.`,
        monthly: pyRound((spendWeek - target) * WEEKS_A_MONTH, 2) });
    }
    if (options.length) out.push(maxBy(options, (o) => o.monthly ?? 0)!);
  }
  if (!used.has("nospend|") && pyRound(s.nospend) < 4) {
    const current = pyRound(s.nospend);
    out.push({ type: "nospend", category: null, target: Math.min(4, Math.max(2, current + 1)),
      why: current ? `You have about ${current} a week now.` : "Most days have some spending now.", monthly: null });
  }
  const shopping = s.cats.get("shopping") ?? [0, 0, []];
  const big = shopping[2].filter((x) => x > 50);
  if (!used.has("wait|shopping") && big.length >= 2) {
    const total = sum(shopping[2]);
    out.push({ type: "wait", category: "shopping", target: 50,
      why: `Shopping was €${fmt0(total)} in the last ${WEEKS} weeks, €${fmt0(total / shopping[2].length)} a time.`, monthly: null });
  }
  // The two that save the most, then the ones about how you spend (no-spend days, waiting first).
  const money = sorted(out.filter((o) => o.monthly), (o) => -o.monthly!).slice(0, 2);
  return [...money, ...out.filter((o) => !o.monthly)].map((o) => ({ ...o, title: habitTitle(o) })).slice(0, 4);
}

/** The Habits tab: this week's scorecard, each habit, and suggestions. */
export async function weekly(conn: Conn): Promise<Row> {
  const rules = await ruleRows(conn);
  const items = [];
  for (const r of rules) items.push(await habitView(conn, r));
  const today = localToday();
  const monday = mondayOf(today);
  const order: Record<string, number> = { missed: 0, at_risk: 1 };
  const worry = sorted(items.filter((h) => h.status in order), (h) => order[h.status]);
  return {
    week: { start: monday.isoformat(), end: monday.addDays(6).isoformat(), days_left: 7 - today.weekday() },
    habits: items, on_track: items.filter((h) => h.status === "on_track" || h.status === "kept").length, total: items.length,
    nudge: worry.length ? { status: worry[0].status, title: worry[0].title, text: worry[0].nudge } : null,
    saved: pyRound(sum(items.map((h) => h.saved)), 2), suggestions: await suggestions(conn, rules),
  };
}

export async function addRule(conn: Conn, type: string, category: string | null, target: number, goalId: number | null = null): Promise<number> {
  let baseline = 0.0;
  if (kindOf(type).tracksMoney && category) {
    const c = (await weeklyStats(conn)).cats.get(category);
    baseline = c ? pyRound(c[1] / WEEKS, 2) : 0.0;
  }
  return habitRulesRepo.add(conn, {
    type, category: type === "nospend" ? null : category, target, baseline, goal_id: goalId, created_at: isoUtc(now(), "seconds"),
  });
}

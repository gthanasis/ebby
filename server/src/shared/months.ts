/** Pay months: from one payday to the day before the next, and which one a day falls in.
 *
 * A PayCalendar answers these for one payday. Each request and job runs inside withPayCalendar(), which reads the
 * person's payday once and keeps it for that piece of work only; the functions below use that calendar. */

import { AsyncLocalStorage } from "node:async_hooks";

import * as clock from "./clock.js";
import * as db from "./db.js";
import { PAYDAY_MIN } from "./constants.js";
import * as transactionsRepo from "./ledger/transactions.js";
import { readSettings } from "./settings.js";
import { median, monthDays, PyDate, pyMod, pyRound } from "./utils/python.js";
import type { Payday } from "../types/entities.js";

// A "month" is a pay month: from one payday up to the day before the next. It's keyed YYYY-MM by the calendar
// month it mostly covers, so with pay on the 25th "2026-10" runs 25 Sep to 24 Oct. Payday 1 (the default) makes
// it the calendar month; "last" is the last working day. Pay that falls on a weekend arrives the Friday before,
// so the month starts then.

function payDate(y: number, m: number, day: Payday): PyDate {
  const last = monthDays(y, m);
  const d = new PyDate(y, m, day === "last" ? last : Math.min(day, last));
  if (day === 1) return d;
  return d.addDays(-Math.max(0, d.weekday() - 4));  // Saturday/Sunday -> Friday
}

const ym = (month: string): [number, number] => month.split("-").map((p) => parseInt(p, 10)) as [number, number];

/** Pay that hasn't arrived yet: the month it would start stays closed until it lands, or until `until`. */
export interface PayWait { expected: string; until: string; amount: number; payer: string }
/** Pay that just arrived and started a month. */
export interface PayArrival { date: string; amount: number; payer: string }

/** Pay months for one payday. starts: months that began on the day pay actually arrived, rather than on the payday
 * (set when someone chooses to start the month when pay arrives); waiting and arrived describe the latest one. */
export class PayCalendar {
  constructor(readonly payday: Payday, readonly starts: Readonly<Record<string, string>> = {},
              readonly waiting: PayWait | null = null, readonly arrived: PayArrival | null = null) {}

  /** [first day, first day of the next month] of a pay month. */
  monthBounds(month: string): [string, string] {
    const [start, end] = this.scheduled(month);
    return [this.starts[month] ?? start, this.starts[shift(month, 1)] ?? end];
  }

  /** The bounds the payday alone gives. */
  scheduled(month: string): [string, string] {
    const day = this.payday;
    if (day === 1) {
      const [y, m] = ym(month);
      return [`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`, new PyDate(y + (m === 12 ? 1 : 0), (m % 12) + 1, 1).isoformat()];
    }
    // Paid late in the month: that pay starts the next month. Paid early: it starts this one.
    const firstMonth = day === "last" || day > 15 ? shift(month, -1) : month;
    return [payDate(...ym(firstMonth), day).isoformat(), payDate(...ym(shift(firstMonth, 1)), day).isoformat()];
  }

  /** The pay month a day belongs to. */
  monthOf(d: PyDate | string): string {
    const day = typeof d === "string" ? PyDate.fromisoformat(d) : d;
    const key = `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}`;
    const [start, end] = this.monthBounds(key);
    if (day.isoformat() < start) return shift(key, -1);
    if (day.isoformat() >= end) return shift(key, 1);
    return key;
  }
}

/** How far before the payday a deposit can land and still be that month's pay. */
const EARLY_DAYS = 5;

/** Months started by pay as it arrived: each month's pay is the first deposit near its payday that's at least 60% of
 * a usual pay. A month whose pay is late hasn't started yet: the one before runs on until the pay lands, for up to
 * `wait` days after the payday, then starts anyway. */
export function payStarts(payday: Payday, deposits: { date: string; amount: number; payer: string }[], today: PyDate, wait: number): PayCalendar {
  const base = new PayCalendar(payday);
  const biggest = new Map<string, number>();
  for (const d of deposits) biggest.set(d.date.slice(0, 7), Math.max(biggest.get(d.date.slice(0, 7)) ?? 0, d.amount));
  if (!biggest.size) return base;
  const usual = median([...biggest.values()]);
  const pay = deposits.filter((d) => d.amount >= usual * 0.6);
  const starts: Record<string, string> = {};
  const last = shift(base.monthOf(today), 1);
  for (let key = base.monthOf(deposits[0].date); key <= last; key = shift(key, 1)) {
    const s0 = PyDate.fromisoformat(base.scheduled(key)[0]);
    const hit = pay.find((d) => d.date >= s0.addDays(-EARLY_DAYS).isoformat() && d.date <= s0.addDays(wait).isoformat());
    if (hit) starts[key] = hit.date;
  }
  const latest = pay.at(-1);
  const payer = latest ? latest.payer : "";
  const typical = pyRound(median(pay.slice(-6).map((d) => d.amount)), 2);
  // This month by the payday: if its pay is due and hasn't come, the month before carries on.
  const current = base.monthOf(today);
  const s0 = PyDate.fromisoformat(base.scheduled(current)[0]);
  let waiting: PayWait | null = null;
  if (!starts[current] && s0.n <= today.n && today.n < s0.addDays(wait).n) {
    starts[current] = today.addDays(1).isoformat();
    waiting = { expected: s0.isoformat(), until: s0.addDays(wait).isoformat(), amount: typical, payer };
  }
  const recent = latest && Object.values(starts).includes(latest.date) && today.diffDays(PyDate.fromisoformat(latest.date)) <= 2 ? latest : null;
  return new PayCalendar(payday, starts, waiting, recent ? { date: recent.date, amount: recent.amount, payer: recent.payer } : null);
}

/** The calendar a person's settings give: their payday, and with month_start "pay", the days pay really came. */
async function readCalendar(): Promise<PayCalendar> {
  return db.connect(async (conn) => {
    const s = await readSettings(conn);
    const day: Payday = s.payday === "last" ? "last" : Number(s.payday);
    if (s.month_start !== "pay") return new PayCalendar(day);
    const today = clock.today();
    const deposits = (await transactionsRepo.payDepositsFrom(conn, PAYDAY_MIN, today.addDays(-430).isoformat()))
      .map((d) => ({ date: d.date, amount: d.amount, payer: d.merchant || d.description }));
    return payStarts(day, deposits, today, s.pay_wait_days ?? DEFAULT_PAY_WAIT);
  });
}

/** Days a month waits for late pay before starting anyway. */
export const DEFAULT_PAY_WAIT = 5;

// The calendar of the work in progress; a box, so a payday changed mid-request applies to the rest of it.
const _calendar = new AsyncLocalStorage<{ cal: PayCalendar }>();

/** The current person's payday, from their settings. */
export async function readPayday(): Promise<Payday> {
  const day = await db.connect(async (conn) => (await readSettings(conn)).payday);
  return day === "last" ? "last" : Number(day);
}

/** Runs fn with the current person's pay calendar, read fresh: every request and every job's work for a person. */
export async function withPayCalendar<T>(fn: () => Promise<T>): Promise<T> {
  return _calendar.run({ cal: await readCalendar() }, fn);
}

/** After saving settings that move the months: the rest of this request or job uses them. */
export async function reloadPayCalendar() {
  const box = _calendar.getStore();
  if (!box) throw new Error("no pay calendar: run the work inside withPayCalendar()");
  box.cal = await readCalendar();
}

/** Runs fn with a given payday (tests, the demo seed). */
export const withPayday = <T>(day: Payday, fn: () => T): T => _calendar.run({ cal: new PayCalendar(day) }, fn);

/** The calendar of the work in progress. */
export function calendar(): PayCalendar {
  const box = _calendar.getStore();
  if (!box) throw new Error("no pay calendar: run the work inside withPayCalendar()");
  return box.cal;
}

/** After saving a new payday: the rest of this request or job uses it. */
export function setPayday(day: Payday) {
  const box = _calendar.getStore();
  if (!box) throw new Error("no pay calendar: run the work inside withPayCalendar()");
  box.cal = new PayCalendar(day);
}

export const monthBounds = (month: string) => calendar().monthBounds(month);
/** Pay that's late and holding the month open, or that just arrived; null otherwise. */
export const payWaiting = () => calendar().waiting;
export const payArrived = () => calendar().arrived;
export const monthOf = (d: PyDate | string) => calendar().monthOf(d);

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

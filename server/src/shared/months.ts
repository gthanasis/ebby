/** Pay months: from one payday to the day before the next, and which one a day falls in.
 *
 * A PayCalendar answers these for one payday. Each request and job runs inside withPayCalendar(), which reads the
 * person's payday once and keeps it for that piece of work only; the functions below use that calendar. */

import { AsyncLocalStorage } from "node:async_hooks";

import * as clock from "./clock.js";
import * as db from "./db.js";
import { monthDays, PyDate, pyMod } from "./utils/python.js";
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

/** Pay months for one payday. */
export class PayCalendar {
  constructor(readonly payday: Payday) {}

  /** [first day, first day of the next month] of a pay month. */
  monthBounds(month: string): [string, string] {
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

// The calendar of the work in progress; a box, so a payday changed mid-request applies to the rest of it.
const _calendar = new AsyncLocalStorage<{ cal: PayCalendar }>();

/** The current person's payday, from their settings. */
export async function readPayday(): Promise<Payday> {
  const day = await db.connect(async (conn) => (await db.getMeta(conn, "settings"))?.payday || 1);
  return day === "last" ? "last" : Number(day);
}

/** Runs fn with the current person's pay calendar, read fresh: every request and every job's work for a person. */
export async function withPayCalendar<T>(fn: () => Promise<T>): Promise<T> {
  return withPayday(await readPayday(), fn);
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

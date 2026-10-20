/**
 * The one place ebby reads the clock. EBBY_NOW (config.NOW) pins it to a moment, such as 2026-10-20T09:00:00+03:00,
 * so tests see the same day every run. Read on every call.
 */

import { config } from "../config.js";
import { PyDate } from "./utils/python.js";

/** Now, as an instant. */
export function now(): Date {
  const pinned = config.NOW;
  return pinned ? new Date(pinned) : new Date();
}

export interface LocalTime {
  date: PyDate; hour: number; minute: number; second: number;
  /** Monday is 0. */
  weekday: number;
}

/** A moment as the wall clock shows it in a time zone. */
export function wallClock(at: Date, timeZone: string): LocalTime {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const date = new PyDate(+parts.year, +parts.month, +parts.day);
  return { date, hour: +parts.hour, minute: +parts.minute, second: +parts.second, weekday: date.weekday() };
}

/** Now where the people using ebby live (TIMEZONE). */
export const localNow = (): LocalTime => wallClock(now(), config.TIMEZONE);

/** Today where the people using ebby live: what pay months, budgets and goals count from. */
export const today = (): PyDate => localNow().date;

/** Today on the server's own clock (its TZ), where the Python code read date.today(). */
export const serverToday = (): PyDate => wallClock(now(), Intl.DateTimeFormat().resolvedOptions().timeZone).date;

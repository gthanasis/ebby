/** What each Claude call costs, and whose key pays for it: friends spend a monthly allowance on the owner's key, or
 * bring their own key with no limit. */

import { wallClock } from "../clock.js";
import { config } from "../config.js";
import { monthName, PyDate } from "../py.js";

/** USD per million tokens. */
interface Price { input: number; cache_write: number; cache_read: number; output: number }
const price = (input: number, cache_write: number, cache_read: number, output: number): Price => ({ input, cache_write, cache_read, output });

// Anthropic first-party API rates (cached 2026-10-06).
export const PRICES: Record<string, Price> = {
  "claude-opus-5-5": price(4.00, 5.00, 0.20, 20.00),
  "claude-sonnet-5-5": price(2.00, 2.50, 0.20, 10.00),
  "claude-haiku-5-5": price(0.10, 0.125, 0.01, 0.50),
};
// Haiku 5.5 costs more once the prompt passes 100K tokens.
const LONG_PROMPT: Record<string, [number, Price]> = { "claude-haiku-5-5": [100_000, price(0.50, 0.625, 0.05, 2.50)] };
// An unknown model is charged at the dearest known price so the allowance never under-counts.
const TOP_PRICE = Object.values(PRICES).reduce((a, b) => (b.output > a.output ? b : a));

export interface Usage { input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null; output_tokens?: number | null }

/** Dollar cost of one response, from its `usage`. */
export function costUsd(model: string, usage: Usage): number {
  const fresh = usage.input_tokens || 0, written = usage.cache_creation_input_tokens || 0;
  const read = usage.cache_read_input_tokens || 0, output = usage.output_tokens || 0;
  let p = PRICES[model] ?? TOP_PRICE;
  const long = LONG_PROMPT[model];
  if (long && fresh + written + read > long[0]) p = long[1];
  return (fresh * p.input + written * p.cache_write + read * p.cache_read + output * p.output) / 1_000_000;
}

const localDate = (at: Date | PyDate) => (at instanceof PyDate ? at : wallClock(at, config.TIMEZONE).date);
const nextMonth = (d: PyDate) => (d.month === 12 ? new PyDate(d.year + 1, 1, 1) : new PyDate(d.year, d.month + 1, 1));

/** The instant a local calendar day starts in the app's timezone. */
function startOfLocalDay(d: PyDate): Date {
  const guess = new Date(Date.UTC(d.year, d.month - 1, d.day));
  // The zone's offset at that moment: how far the wall clock there is from UTC.
  const wall = wallClock(guess, config.TIMEZONE);
  const wallMs = Date.UTC(wall.date.year, wall.date.month - 1, wall.date.day, wall.hour, wall.minute, wall.second);
  return new Date(guess.getTime() - (wallMs - guess.getTime()));
}

/** Start (inclusive) and end (exclusive) of this month in the app's timezone, for summing usage. */
export function monthBounds(at: Date | PyDate): [Date, Date] {
  const day = localDate(at);
  return [startOfLocalDay(new PyDate(day.year, day.month, 1)), startOfLocalDay(nextMonth(day))];
}

export const resetsOn = (at: Date | PyDate) => nextMonth(localDate(at));

/** This month's allowance on the shared key is used up. */
export class BudgetExceeded extends Error {
  constructor(readonly spent: number, readonly budget: number, readonly resets: PyDate) {
    super(`You've used this month's AI allowance. It resets on ${resets.day} ${monthName(resets)}, or add your own Anthropic key in Settings.`);
  }
}

/** Neither the user nor the server has an Anthropic key. */
export class NoAPIKey extends Error {
  constructor() { super("AI features need an Anthropic key. Add your own in Settings."); }
}

/** The key to call Claude with, and whether it is the user's own (which has no limit). */
export function chooseKey(o: { ownKey: string | null; sharedKey: string; isAdmin: boolean; spent: number; budget: number; today: Date | PyDate }): [string, boolean] {
  if (o.ownKey) return [o.ownKey, true];
  if (!o.sharedKey) throw new NoAPIKey();
  if (!o.isAdmin && o.spent >= o.budget) throw new BudgetExceeded(o.spent, o.budget, resetsOn(o.today));
  return [o.sharedKey, false];
}

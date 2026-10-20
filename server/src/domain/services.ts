/** Services: one name per merchant however the bank writes it, a category's services, one service in detail,
 * and moving a service's payments to another category. */

import * as db from "../data/db.js";
import { type Conn, type Row } from "../data/db.js";
import * as rulesRepo from "../data/repos/rules.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { PyDate, pyRound, sorted, sum } from "../py.js";
import { MCC_NAMES } from "./reference/mcc.js";
import { monthBounds, shift } from "./months.js";

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

export const sn = (r: Row) => serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc);

async function serviceRows(conn: Conn, category: string, name: string, start?: string | null, end?: string | null): Promise<Row[]> {
  return (await transactionsRepo.servicePayments(conn, category, start, end)).filter((r) => sn(r) === name);
}

export async function serviceDetail(conn: Conn, category: string, name: string, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const rows = await serviceRows(conn, category, name, start, end);
  const spent = pyRound(-sum(rows.map((r) => r.amount)), 2);
  const count = rows.filter((r) => r.amount < 0).length;
  const categoryTotal = await transactionsRepo.categorySpent(conn, start, end, category);
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

export async function serviceIdsAnywhere(conn: Conn, name: string): Promise<Row[]> {
  return (await transactionsRepo.payees(conn)).filter((r) => sn(r) === name);
}

/** All payments to a service go to category, now and in future (rules keyed by merchant). */
export async function setServiceCategory(conn: Conn, name: string, category: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) {
    await rulesRepo.set(conn, r.merchant || `tx:${r.id}`, category);
  }
  await db.recategorize(conn);
  return rows.length;
}

/** Undo setServiceCategory: drop the service's rules so its payments go back to being worked out. */
export async function clearServiceCategory(conn: Conn, name: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) await rulesRepo.remove(conn, r.merchant || `tx:${r.id}`);
  await db.recategorize(conn);
  return rows.length;
}

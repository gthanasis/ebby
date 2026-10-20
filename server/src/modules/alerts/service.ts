/** Cool-down alerts: run after each sync, push once per category per level per month. */

import * as clock from "../../shared/clock.js";
import * as db from "../../shared/db.js";
import type { Conn, Row } from "../../shared/db.js";
import * as wishlistRepo from "../habits/wishlist_repo.js";
import * as push from "./push.js";
import { fmt0, sorted } from "../../shared/utils/python.js";
import { CATEGORIES } from "../../shared/categories.js";
import * as habits from "../habits/service.js";
import { commitmentsView } from "../commitments/service.js";
import { getPlan } from "../plan/service.js";
import { pace } from "../plan/pace.js";
import { thisMonth } from "../../shared/months.js";
import { readSettings } from "../../shared/settings.js";
import type { MetaDocuments } from "../../types/entities.js";

const LEVELS: Record<string, number> = { ahead: 1, over: 2 };

/** A push's title and body: one item in its own words, or several together. */
function message(items: Row[], one: (item: Row) => [string, string], many: (items: Row[]) => [string, string]): [string, string] {
  return items.length === 1 ? one(items[0]) : many(items);
}

/** Adds what was just delivered to this month's record. The document keeps only the current month. */
async function markSent<K extends "alerts_sent" | "commitment_alerts">(
  conn: Conn, key: K, month: string, add: (sent: MetaDocuments[K][string] | undefined) => MetaDocuments[K][string],
) {
  const state = ((await db.getMeta(conn, key)) || {}) as Record<string, MetaDocuments[K][string]>;
  await db.setMeta(conn, key, { [month]: add(state[month]) } as MetaDocuments[K]);
}

export const localNow = () => clock.localNow();
export const quietHours = () => { const h = localNow().hour; return !(9 <= h && h < 22); };

/** Categories that crossed a level since the last alert this month. */
export async function pending(conn: Conn, month: string): Promise<Row[]> {
  const sent = ((await db.getMeta(conn, "alerts_sent")) || {})[month] || {};
  const out = [];
  for (const c of (await pace(conn, month)).categories) {
    const level = LEVELS[c.status];
    if (level && level > (sent[c.category] ?? 0)) out.push({ ...c, level });
  }
  return out;
}

/** Warns once a month per commitment that goes past its limit. No other advice: it's a chosen cost. */
export async function checkCommitments(conn: Conn, month: string): Promise<number> {
  const sent: number[] = ((await db.getMeta(conn, "commitment_alerts")) || {})[month] || [];
  const over = (await commitmentsView(conn, month)).items.filter((c: Row) => c.over && !sent.includes(c.id));
  if (!over.length) return 0;
  const [title, body] = message(over,
    (c) => [`${c.name} is past its limit`, `€${fmt0(c.spent)} this month, your limit is €${fmt0(c.monthly_limit)}.`],
    (cs) => ["Commitments past their limits", cs.slice(0, 3).map((c) => `${c.name} €${fmt0(c.spent)} of €${fmt0(c.monthly_limit)}`).join(", ")]);
  const delivered = await push.send(title, body, "/#/committed/", `committed-${month}`);
  if (delivered) await markSent(conn, "commitment_alerts", month, (ids) => [...(ids || []), ...over.map((c: Row) => c.id)]);
  return delivered;
}

/** The 48-hour rule: ask once whether each thing is still worth it. */
export async function checkWishlist(conn: Conn): Promise<number> {
  const due = await habits.dueReminders(conn);
  if (!due.length) return 0;
  const w = due[0];
  const hours = w.hours_of_work ? ` That's about ${fmt0(w.hours_of_work, false)} hours of work.` : "";
  const title = due.length === 1 ? `Still want ${w.name}?` : `Still want ${w.name} and ${due.length - 1} more?`;
  const sent = await push.send(title, `You added it two days ago, €${fmt0(w.price)}.${hours}`, "/#/goals/section=wishlist", "wishlist");
  if (sent) await wishlistRepo.markReminded(conn, due.map((x) => x.id));
  return sent;
}

/** Sends due alerts. Returns how many notifications went out. */
export async function check(): Promise<number> {
  if (quietHours()) return 0;  // left pending; the next check after 09:00 sends them
  const month = thisMonth();
  return db.connect(async (conn) => {
    const { alerts } = await readSettings(conn);
    if (alerts) await checkCommitments(conn, month);
    await checkWishlist(conn);
    if (!(await getPlan(conn)) || !alerts) return 0;
    const due = sorted(await pending(conn, month), (c) => -(c.spent - (c.budget || 0)));
    if (!due.length) return 0;
    const top = due[0];
    const label = CATEGORIES[top.category][0].toLowerCase();
    const [title, body] = message(due,
      (c) => [c.level === 2 ? `Time to cool down on ${label}` : `${CATEGORIES[c.category][0]} is running ahead`, `€${fmt0(c.spent)} this month. ${c.habit}`],
      (cs) => {
        const names = cs.slice(0, 3).map((c) => CATEGORIES[c.category][0].toLowerCase()).join(", ");
        return ["Time to cool down", `Ahead of plan on ${names}. Biggest: ${label}, €${fmt0(top.spent)} this month.`];
      });
    const sent = await push.send(title, body, `/#/spending/category=${top.category}`, `cooldown-${month}`);
    if (!sent) return 0;  // no device subscribed yet; keep it pending rather than mark it seen
    console.info(`cool-down alert for ${due.map((c) => c.category).join(", ")}: ${sent} device(s)`);
    await markSent(conn, "alerts_sent", month, (levels) => ({ ...(levels || {}), ...Object.fromEntries(due.map((c) => [c.category, c.level])) }));
    return sent;
  });
}

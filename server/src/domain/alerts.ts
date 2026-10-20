/** Cool-down alerts: run after each sync, push once per category per level per month. */

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import type { Conn, Row } from "../data/db.js";
import * as push from "../integrations/push.js";
import { fmt0, sorted } from "../py.js";
import { CATEGORIES } from "./categories.js";
import * as habits from "./habits.js";
import * as insights from "./insights.js";

const LEVELS: Record<string, number> = { ahead: 1, over: 2 };

export const localNow = () => clock.localNow();
export const quietHours = () => { const h = localNow().hour; return !(9 <= h && h < 22); };

/** Categories that crossed a level since the last alert this month. */
export async function pending(conn: Conn, month: string): Promise<Row[]> {
  const sent = ((await db.getMeta(conn, "alerts_sent")) || {})[month] || {};
  const out = [];
  for (const c of (await insights.pace(conn, month)).categories) {
    const level = LEVELS[c.status];
    if (level && level > (sent[c.category] ?? 0)) out.push({ ...c, level });
  }
  return out;
}

/** Warns once a month per commitment that goes past its limit. No other advice: it's a chosen cost. */
export async function checkCommitments(conn: Conn, month: string): Promise<number> {
  const sent: number[] = ((await db.getMeta(conn, "commitment_alerts")) || {})[month] || [];
  const over = (await insights.commitmentsView(conn, month)).items.filter((c: Row) => c.over && !sent.includes(c.id));
  if (!over.length) return 0;
  let title: string, body: string;
  if (over.length === 1) {
    const c = over[0];
    title = `${c.name} is past its limit`;
    body = `€${fmt0(c.spent)} this month, your limit is €${fmt0(c.monthly_limit)}.`;
  } else {
    title = "Commitments past their limits";
    body = over.slice(0, 3).map((c: Row) => `${c.name} €${fmt0(c.spent)} of €${fmt0(c.monthly_limit)}`).join(", ");
  }
  const delivered = await push.send(title, body, "/#/committed/", `committed-${month}`);
  if (delivered) {
    const state = (await db.getMeta(conn, "commitment_alerts")) || {};
    await db.setMeta(conn, "commitment_alerts", { [month]: [...(state[month] || []), ...over.map((c: Row) => c.id)] });
  }
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
  if (sent) await conn.execute(`UPDATE wishlist SET reminded = 1 WHERE id IN (${due.map(() => "?").join(",")})`, due.map((x) => x.id));
  return sent;
}

/** Sends due alerts. Returns how many notifications went out. */
export async function check(): Promise<number> {
  if (quietHours()) return 0;  // left pending; the next check after 09:00 sends them
  const month = insights.thisMonth();
  return db.connect(async (conn) => {
    const settings = (await db.getMeta(conn, "settings")) || {};
    if (settings.alerts ?? true) await checkCommitments(conn, month);
    await checkWishlist(conn);
    if (!(await insights.getPlan(conn)) || !(settings.alerts ?? true)) return 0;
    const due = sorted(await pending(conn, month), (c) => -(c.spent - (c.budget || 0)));
    if (!due.length) return 0;
    const top = due[0];
    const label = CATEGORIES[top.category][0].toLowerCase();
    let title: string, body: string;
    if (due.length === 1) {
      title = top.level === 2 ? `Time to cool down on ${label}` : `${CATEGORIES[top.category][0]} is running ahead`;
      body = `€${fmt0(top.spent)} this month. ${top.habit}`;
    } else {
      const names = due.slice(0, 3).map((c) => CATEGORIES[c.category][0].toLowerCase()).join(", ");
      title = "Time to cool down";
      body = `Ahead of plan on ${names}. Biggest: ${label}, €${fmt0(top.spent)} this month.`;
    }
    const sent = await push.send(title, body, `/#/spending/category=${top.category}`, `cooldown-${month}`);
    if (!sent) return 0;  // no device subscribed yet; keep it pending rather than mark it seen
    console.info(`cool-down alert for ${due.map((c) => c.category).join(", ")}: ${sent} device(s)`);
    const state = (await db.getMeta(conn, "alerts_sent")) || {};
    await db.setMeta(conn, "alerts_sent", { [month]: { ...(state[month] || {}), ...Object.fromEntries(due.map((c) => [c.category, c.level])) } });
    return sent;
  });
}

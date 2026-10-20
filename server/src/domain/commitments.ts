/** Commitments: fixed and chosen costs, kept apart from free spending. */

import type { Selectable } from "kysely";

import { type Conn, first, type Row } from "../data/db.js";
import { maxBy, monthDays, PyDate, pyMod, pyRound, sorted, sum } from "../py.js";
import type { Commitments } from "../types/db.js";
import type { Commitment } from "../types/entities.js";
import { COMMITTED_SQL } from "./spend_sql.js";
import { localToday, monthBounds, monthOf, shift, thisMonth } from "./months.js";
import { sn } from "./services.js";
import { subscriptions } from "./subscriptions.js";

async function commitmentRows(conn: Conn): Promise<Commitment[]> {
  const out: Commitment[] = [];
  for (const r of await conn.execute<Selectable<Commitments>>("SELECT * FROM commitments ORDER BY kind, name")) {
    const c: Commitment = { ...r, services: JSON.parse(r.services) };
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
function cycle(c: Commitment): Pick<Commitment, "next_date" | "last_date" | "amount" | "set_aside"> {
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
    const cap = c.every_months > 1 ? c.amount ?? c.monthly_limit * c.every_months : c.monthly_limit;
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

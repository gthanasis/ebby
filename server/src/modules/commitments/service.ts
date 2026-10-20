/** Commitments: fixed and chosen costs, kept apart from free spending. */

import { type Conn, type Row } from "../../shared/db.js";
import * as commitmentsRepo from "./repo.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { addMonths } from "../../shared/utils/dates.js";
import { maxBy, PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import type { Commitment as CommitmentRow } from "../../types/entities.js";
import { type Commitment, toCommitment, toCommitmentSuggestion } from "./converters.js";
import { localToday, monthBounds, monthOf, shift, thisMonth } from "../../shared/months.js";
import { sn } from "../spending/services.js";
import { subscriptions } from "../spending/subscriptions.js";

async function commitmentRows(conn: Conn): Promise<CommitmentRow[]> {
  const out: CommitmentRow[] = [];
  for (const r of await commitmentsRepo.all(conn)) {
    const c: CommitmentRow = { ...r, services: JSON.parse(r.services) };
    if (c.every_months > 1) Object.assign(c, cycle(c));
    out.push(c);
  }
  return out;
}

/** For a cost paid every few months: the next payment (moved on once its date has passed), and what should be put
 * aside towards it by now, a monthly share at a time since the last one. */
function cycle(c: CommitmentRow): Pick<CommitmentRow, "next_date" | "last_date" | "amount" | "set_aside"> {
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
  await transactionsRepo.clearCommitments(conn);
  if (!byService.size) return;
  for (const r of await transactionsRepo.nonZeroPayees(conn)) {
    const cid = byService.get(sn(r));
    if (cid) await transactionsRepo.setCommitment(conn, r.id, cid);
  }
}

async function committedSpent(conn: Conn, cid: number, start: string, end: string): Promise<number> {
  return pyRound(await transactionsRepo.committedTo(conn, cid, start, end), 2);
}

export async function commitmentsView(conn: Conn, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const items: Commitment[] = [];
  for (const c of await commitmentRows(conn)) {
    const spent = await committedSpent(conn, c.id, start, end) + c.off_bank;
    const history = [];
    for (let i = 5; i >= 0; i--) {
      const m = shift(month, -i);
      const [ms, me] = monthBounds(m);
      history.push({ month: m, spent: pyRound(await committedSpent(conn, c.id, ms, me) + c.off_bank, 2) });
    }
    const count = await transactionsRepo.committedCount(conn, c.id, start, end);
    // A cost paid every few months is over only when a payment goes past its amount, not its monthly share.
    const cap = c.every_months > 1 ? c.amount ?? c.monthly_limit * c.every_months : c.monthly_limit;
    items.push(toCommitment(c, spent, count, spent > cap + 0.005, history));
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
    .map(([n, m]) => toCommitmentSuggestion(n, m));
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
  for (const r of await transactionsRepo.outgoingSince(conn, since, transfers)) {
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

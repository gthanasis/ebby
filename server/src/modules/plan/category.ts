/** One spending category over a pay month: who it went to, its last six months, and its budget. */

import type { Conn, Row } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { pyRound, sorted, sum } from "../../shared/utils/python.js";
import { monthBounds, shift } from "../../shared/months.js";
import { budgetsFor, getPlan } from "./service.js";
import { sn } from "../spending/services.js";

export async function categoryDetail(conn: Conn, category: string, month: string): Promise<Row> {
  const [start, end] = monthBounds(month);
  const services = new Map<string, { amount: number; count: number; accounts: Set<string> }>();
  for (const r of await transactionsRepo.categoryPayments(conn, start, end, category)) {
    const name = sn(r);
    if (!services.has(name)) services.set(name, { amount: 0.0, count: 0, accounts: new Set() });
    const s = services.get(name)!;
    s.amount -= r.amount; s.count += 1; s.accounts.add(r.account);
  }
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const m = shift(month, -i);
    const [ms, me] = monthBounds(m);
    const v = await transactionsRepo.categorySpent(conn, ms, me, category);
    history.push({ month: m, spent: pyRound(v, 2) });
  }
  const budget = budgetsFor(await getPlan(conn), month)[category] ?? null;
  return {
    category, month, budget, history,
    spent: pyRound(sum([...services.values()].map((s) => s.amount)), 2),
    services: sorted([...services.entries()].filter(([, s]) => s.amount > 0).map(([n, s]) => ({
      name: n, amount: pyRound(s.amount, 2), count: s.count, accounts: sorted(s.accounts),
    })), (s) => -s.amount),
  };
}

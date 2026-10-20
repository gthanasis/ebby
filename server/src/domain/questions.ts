/** Questions the assistant asks: payments left in Other. */

import { type Conn, type Row } from "../data/db.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { pyRound, sorted } from "../utils/python.js";
import { localToday } from "./months.js";
import { sn } from "./services.js";

/** One question per payee left in Other over the last 90 days, biggest first. */
export async function questions(conn: Conn, limit = 10): Promise<Row[]> {
  const since = localToday().addDays(-90).isoformat();
  const rows = await transactionsRepo.leftInOther(conn, since);
  const out = new Map<string, Row>();
  for (const r of rows) {
    const n = sn(r);
    if (!out.has(n)) out.set(n, { service: n, tx_id: r.id, count: 0, amount: 0.0, date: r.date, account: r.account, has_merchant: Boolean(r.merchant) });
    const q = out.get(n)!;
    q.count += 1;
    q.amount = pyRound(q.amount - r.amount, 2);
  }
  return sorted(out.values(), (q) => -q.amount).slice(0, limit);
}

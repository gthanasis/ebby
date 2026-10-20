/** Questions the assistant asks: payments left in Other. */

import { type Conn, type Row } from "../data/db.js";
import { pyRound, sorted } from "../py.js";
import { localToday } from "./months.js";
import { sn } from "./services.js";

/** One question per payee left in Other over the last 90 days, biggest first. */
export async function questions(conn: Conn, limit = 10): Promise<Row[]> {
  const since = localToday().addDays(-90).isoformat();
  const rows = (await conn.execute(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card, a.name AS account
    FROM transactions t JOIN accounts a ON a.id = t.account
    WHERE t.category = 'other' AND t.amount < 0 AND t.date >= ? AND t.duplicate_of IS NULL AND t.commitment_id IS NULL
      AND t.status != 'OFFSET' ORDER BY t.amount`, [since])).rows;
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

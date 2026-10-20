/** Finding the payday in the transactions, for the plan and the hint that offers it. */

import type { Conn, Row } from "../../shared/db.js";
import { PAYDAY_MIN } from "../../shared/constants.js";
import { localToday } from "../../shared/months.js";
import { maxBy, median, PyDate, pyRound } from "../../shared/utils/python.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";

/** When pay seems to arrive: the day of month that the biggest monthly deposit keeps landing on. A Friday deposit
 * also counts for the weekend after it, since weekend pay comes early. */
export async function detectPayday(conn: Conn): Promise<Row | null> {
  const since = localToday().addDays(-240).isoformat();
  const biggest = new Map<string, Row>();
  for (const r of await transactionsRepo.payDeposits(conn, PAYDAY_MIN, since)) {
    const k = r.date.slice(0, 7);
    if (!biggest.has(k) || r.amount > biggest.get(k)!.amount) biggest.set(k, r);
  }
  const votes = new Map<number, Row[]>();
  for (const r of biggest.values()) {
    const d = PyDate.fromisoformat(r.date);
    for (const extra of d.weekday() === 4 ? [0, 1, 2] : [0]) {
      const nd = d.addDays(extra);
      if (nd.month === d.month) {
        if (!votes.has(nd.day)) votes.set(nd.day, []);
        votes.get(nd.day)!.push(r);
      }
    }
  }
  if (!votes.size) return null;
  const [day, hits] = maxBy(votes.entries(), ([d, h]) => [h.length, d ? -d : 0])!;
  if (hits.length < 3) return null;
  const last = maxBy(hits, (r) => r.date)!;
  return { day, amount: pyRound(median(hits.map((r) => r.amount)), 2), last: last.date, months: hits.length };
}

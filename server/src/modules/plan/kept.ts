/** What each pay month kept: the money that came in, less what was spent and what fixed costs took, against what the
 * plan says to keep. A cost paid every few months (rent paid ahead, a yearly insurance) counts at its monthly share
 * in every month, so the month it goes out doesn't read as a loss and the months between as a win. */

import type { Conn } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { dayProgress, monthBounds, shift, thisMonth } from "../../shared/months.js";
import { pyRound, sum } from "../../shared/utils/python.js";
import * as commitmentsRepo from "../commitments/repo.js";
import { type Kept, type KeptMonth, toKept } from "./converters.js";
import { getPlan } from "./service.js";

/** The current pay month and the `count` before it, oldest first. */
export async function kept(conn: Conn, count = 6): Promise<Kept> {
  const plan = await getPlan(conn);
  const costs = await commitmentsRepo.all(conn);
  const current = thisMonth();
  const months: KeptMonth[] = [];
  for (let k = count; k >= 0; k--) {
    const month = shift(current, -k);
    const [start, end] = monthBounds(month);
    const [elapsed, length] = dayProgress(month);
    const partial = month === current;
    const income = pyRound(await transactionsRepo.income(conn, start, end), 2);
    const spending = pyRound(await transactionsRepo.spent(conn, start, end), 2);
    // Monthly costs as they went out (and what's paid outside the accounts); the rest at their monthly share.
    let fixed = 0.0, fixedExpected = 0.0;
    for (const c of costs) {
      if (c.every_months > 1) { fixed += c.monthly_limit; fixedExpected += c.monthly_limit; continue; }
      const paid = (await transactionsRepo.committedTo(conn, c.id, start, end)) + c.off_bank;
      fixed += paid;
      fixedExpected += Math.max(paid, c.monthly_limit);
    }
    const kept = income - spending - fixed;
    // A month still running: its spending carried on at the pace so far, the fixed costs not yet paid added, and
    // the plan's pay if none has come in yet.
    const projected = partial && elapsed
      ? Math.max(income, income ? 0 : plan?.take_home ?? 0) - spending / elapsed * length - fixedExpected
      : null;
    months.push({
      month, start, end, partial, income, spending, fixed: pyRound(fixed, 2), kept: pyRound(kept, 2),
      projected: projected == null ? null : pyRound(projected, 2),
    });
  }
  const done = months.filter((m) => !m.partial && m.income > 0);
  const average = done.length ? pyRound(sum(done.map((m) => m.kept)) / done.length, 2) : null;
  return toKept(plan?.keep ?? null, months, average);
}

/** Subscriptions: services charged most months at a steady-ish amount. */

import * as clock from "../../shared/clock.js";
import { type Conn } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { median, PyDate, pyRound, sorted } from "../../shared/utils/python.js";
import { monthBounds, monthOf, shift, thisMonth } from "../../shared/months.js";
import { serviceName } from "./services.js";
import { type Subscription, type Subscriptions, toSubscriptions } from "./converters.js";

/** Services charged in at least 3 of the last 6 months, with a steady-ish monthly cost. */
export async function subscriptions(conn: Conn): Promise<Subscriptions> {
  const since = monthBounds(shift(thisMonth(), -6))[0];
  const byService = new Map<string, Map<string, number>>();
  const last = new Map<string, string>();
  for (const r of await transactionsRepo.subscriptionCandidates(conn, since)) {
    if (r.is_card && !r.merchant) continue;  // card rows have no name, so they can't be told apart as services
    const name = serviceName(r.merchant, r.description, false, r.mcc);
    if (!byService.has(name)) byService.set(name, new Map());
    const months = byService.get(name)!, m = monthOf(r.date);
    months.set(m, (months.get(m) ?? 0) - r.amount);
    last.set(name, (last.get(name) ?? "") > r.date ? last.get(name)! : r.date);
  }
  const today = clock.serverToday();
  const items: Subscription[] = [];
  for (const [name, months] of byService) {
    if (months.size < 3) continue;
    const recent = sorted(months.keys()).slice(-3).map((m) => months.get(m)!);
    const monthly = pyRound(median(recent), 2);
    const lastCharge = PyDate.fromisoformat(last.get(name)!);
    const stale = today.diffDays(lastCharge) > 45;
    items.push({
      name, monthly, months: months.size, last_charge: last.get(name)!,
      next_charge: stale ? null : lastCharge.addDays(30).isoformat(),
      varies: Math.max(...recent) - Math.min(...recent) > Math.max(2.0, monthly * 0.15), stale,
    });
  }
  return toSubscriptions(items);
}

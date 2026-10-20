/** The Home card: today, this week and this pay month against the plan. */

import { type Conn, type Row } from "../data/db.js";
import * as goalsRepo from "../data/repos/goals.js";
import * as transactionsRepo from "../data/repos/transactions.js";
import { PyDate, pyRound, sorted, sum } from "../py.js";
import { budgetsFor, getPlan, roundTo } from "./plan.js";
import { categoryRows } from "./pace.js";
import { committedTotal } from "./commitments.js";
import { localToday, monthBounds, shift, thisMonth } from "./months.js";

/** Spending from start up to and including end. */
export async function spentBetween(conn: Conn, start: PyDate, end: PyDate): Promise<number> {
  return pyRound(await transactionsRepo.spentThrough(conn, start.isoformat(), end.isoformat()), 2);
}

/** This pay month so far, for Today: each day's spending, the average day, where the month ends at that pace,
 * and where the money went. Everything counts the same days (the start of the month up to and including today),
 * so the totals agree. */
export async function todayView(conn: Conn): Promise<Row> {
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const length = end.diffDays(firstDay);
  const byDay = new Map((await transactionsRepo.spentPerDayThrough(conn, firstDay.isoformat(), today.isoformat()))
    .map((r) => [r.date, pyRound(r.spent, 2)]));
  const days = Array.from({ length }, (_, i) => firstDay.addDays(i)).map((d) => ({
    date: d.isoformat(), spent: d.n <= today.n ? (byDay.get(d.isoformat()) ?? 0.0) : null,
  }));
  const spent = pyRound(sum(byDay.values()), 2);
  const elapsed = today.diffDays(firstDay) + 1;
  const rows = await categoryRows(conn, firstDay.isoformat(), today.addDays(1).isoformat());
  const categories = sorted([...rows.entries()].filter(([, r]) => r.spent > 0).map(([c, r]) => ({ category: c, ...r })), (c) => -c.spent);
  return {
    month, start: firstDay.isoformat(), end: end.isoformat(), today: today.isoformat(),
    length, elapsed, spent, days,
    average: pyRound(spent / elapsed, 2), projected: pyRound(spent / elapsed * length, 2),
    categories, ideal: await ideal(conn, length),
  };
}

/** What the month should look like: income less savings, fixed costs and what each goal needs a month, shared
 * over the days and across categories in the plan's proportions. */
async function ideal(conn: Conn, length: number): Promise<Row | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const goals = [];
  for (const r of await goalsRepo.progress(conn)) {
    const daysLeft = Math.max(1, PyDate.fromisoformat(r.target_date).diffDays(localToday()));
    goals.push({ name: r.name, price: r.price, target_date: r.target_date, monthly: pyRound(Math.max(0.0, r.price - r.saved) / (daysLeft / 30.44), 2) });
  }
  const fixed = await committedTotal(conn);
  const budget = Math.max(0.0, plan.take_home - plan.keep - fixed - sum(goals.map((g) => g.monthly)));
  const shares: Record<string, number> = plan.budgets;
  const total = sum(Object.values(shares));
  return {
    income: plan.take_home, savings: plan.keep, fixed, goals,
    budget: pyRound(budget, 2), day: pyRound(budget / length, 2),
    targets: total ? Object.fromEntries(Object.entries(shares).map(([c, v]) => [c, pyRound(v * budget / total, 2)])) : {},
  };
}

/**
 * What's left today, this week and this month. None without a plan.
 *
 * Day: what's left of the month shared over the days to go (today included) - mode "share". When that's out of
 * reach (the plan is used up, or staying on it would take under 60% of the recent daily pace) a plan day would just
 * be ignored, so mode "catch_up" sets a realistic day instead: three quarters of the recent pace, never below a plan
 * day, never above the pace itself. finish is where the month lands at that rate, and suggest_limit offers a working
 * limit for next month on the way back down to the plan (or for this month, early in it, after a bad one).
 * Week: Monday to Sunday, limit = a normal plan day x 7.
 * Month: every day's spending so far (None for days still to come), for the day strip.
 */
export async function periods(conn: Conn): Promise<Row | null> {
  const plan = await getPlan(conn);
  if (!plan) return null;
  const today = localToday();
  const month = thisMonth();
  const [firstDay, end] = monthBounds(month).map(PyDate.fromisoformat);
  const days = end.diffDays(firstDay);
  const goal = sum(Object.values<number>(plan.budgets));
  const monthly = sum(Object.values(budgetsFor(plan, month)));
  const perDay = monthly / days;
  const monthSpent = await spentBetween(conn, firstDay, end.addDays(-1));
  const beforeToday = today.n > firstDay.n ? await spentBetween(conn, firstDay, today.addDays(-1)) : 0.0;
  const todaySpent = await spentBetween(conn, today, today);
  const daysLeft = end.diffDays(today);
  const leftForMonth = monthly - beforeToday;
  const gone = today.diffDays(firstDay);
  const paceDaily = gone >= 3 ? beforeToday / gone : null;
  const need = leftForMonth / daysLeft;
  let dayLimit: number, mode: string;
  if (paceDaily && (need <= 0 || need < 0.6 * paceDaily) && paceDaily > perDay) {
    dayLimit = Math.min(paceDaily, Math.max(perDay, need, roundTo(0.75 * paceDaily, 5))); mode = "catch_up";
  } else if (need > 0) {
    dayLimit = need; mode = "share";
  } else {
    dayLimit = perDay; mode = "catch_up";
  }
  const finish = beforeToday + dayLimit * daysLeft;

  const limits = plan.limits || {};
  let suggest: Row | null = null;
  if (mode === "catch_up" && !(shift(month, 1) in limits)) {
    suggest = { month: shift(month, 1), limit: Math.max(goal, roundTo(0.9 * finish, 50)), goal };
  } else if (!(month in limits) && gone <= 5) {
    const [ps, pe] = monthBounds(shift(month, -1));
    const last = await spentBetween(conn, PyDate.fromisoformat(ps), PyDate.fromisoformat(pe).addDays(-1));
    if (last > goal * 1.05) suggest = { month, limit: Math.max(goal, roundTo(0.9 * last, 50)), goal, last };
  }

  const monday = today.addDays(-today.weekday());
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = monday.addDays(i);
    weekDays.push({ date: d.isoformat(), spent: d.n <= today.n ? await spentBetween(conn, d, d) : null });
  }
  const weekSpent = pyRound(sum(weekDays.map((d) => d.spent || 0)), 2);
  const monthDaysList = [];
  for (let i = 0; i < days; i++) {
    const d = firstDay.addDays(i);
    monthDaysList.push({ date: d.isoformat(), spent: d.n <= today.n ? await spentBetween(conn, d, d) : null });
  }
  return {
    today: today.isoformat(),
    day: {
      spent: todaySpent, limit: pyRound(dayLimit, 2), mode, days_left: daysLeft,
      left_for_month: pyRound(leftForMonth, 2), pace: paceDaily ? pyRound(paceDaily, 2) : null, finish: pyRound(finish, 2),
    },
    week: { spent: weekSpent, limit: pyRound(perDay * 7, 2), daily_limit: pyRound(perDay, 2), start: monday.isoformat(), days: weekDays },
    month: { key: month, spent: monthSpent, limit: pyRound(monthly, 2), goal, days_left: daysLeft - 1, daily_limit: pyRound(perDay, 2), days: monthDaysList },
    suggest_limit: suggest,
  };
}

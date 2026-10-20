/**
 * The Spending tab: any day, week, pay month or year, what happened in it, and how it compares.
 *
 * Everything is worked out from one set of rows per period (free spending, the same rows Today uses), so the total,
 * the chart, the categories and the highlights always agree. "Usual" is the median of the periods before, cut to the
 * same number of days while the period is still going, so a half-finished month is compared with half-finished months.
 */

import type { Conn, Row } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { fmt0, fmt2, maxBy, median, PyDate, pyRound, sorted, sum } from "../../shared/utils/python.js";
import { localToday, monthBounds, monthOf, shift, thisMonth } from "../../shared/months.js";
import { serviceName } from "./services.js";

type Range = "day" | "week" | "month" | "year";

/** Where each range's periods start and end, given today. */
const PERIOD: Record<Range, (today: PyDate, off: number) => [PyDate, PyDate, string]> = {
  day: (today, off) => {
    const d = today.addDays(off);
    return [d, d, d.isoformat()];
  },
  week: (today, off) => {
    const monday = today.addDays(-today.weekday() + 7 * off);
    return [monday, monday.addDays(6), monday.isoformat()];
  },
  month: (_, off) => {
    const key = shift(thisMonth(), off);
    const [a, b] = monthBounds(key);
    return [PyDate.fromisoformat(a), PyDate.fromisoformat(b).addDays(-1), key];
  },
  year: (_, off) => {
    const y = parseInt(thisMonth().slice(0, 4), 10) + off;
    return [PyDate.fromisoformat(monthBounds(`${y}-01`)[0]), PyDate.fromisoformat(monthBounds(`${y}-12`)[1]).addDays(-1), String(y)];
  },
};

export const RANGES: string[] = Object.keys(PERIOD);

interface Compared {
  /** How many periods before "usual" is the median of. */
  usualCount: number;
  /** Periods before this one on the trend chart. */
  trendLength: number;
  /** The least a category must move from usual to be a highlight. */
  minMove: number;
  /** The share of the total one payment must reach to be a highlight. */
  bigPayment: number;
  /** Whether a weekday that stands out is a highlight. */
  weekdays: boolean;
}

/** The ranges compared category by category with the periods before them. Day and year have views of their own. */
const COMPARED: Record<"week" | "month", Compared> = {
  week: { usualCount: 8, trendLength: 7, minMove: 20, bigPayment: 0.12, weekdays: false },
  month: { usualCount: 6, trendLength: 11, minMove: 40, bigPayment: 0.08, weekdays: true },
};

/** A day's usual: the same weekday over this many weeks before. */
const USUAL_DAY_COUNT = 8;

// How often matters for these, so their counts are worth saying.
export const HABITS = new Set(["delivery", "eating_out", "coffee_bars", "people", "groceries"]);
// A drop here is usually timing (not charged yet), not something you did.
export const TIMED = new Set(["bills", "health", "car", "subscriptions", "pets", "insurance", "loans", "education"]);

export interface SpendRow { date: string; amount: number; category: string; name: string }

const med = (values: number[]) => (values.length ? median(values) : 0.0);

/** [first day, last day, key] of the period `off` steps from the current one. */
export function bounds(rng: string, off: number): [PyDate, PyDate, string] {
  return PERIOD[Object.hasOwn(PERIOD, rng) ? rng as Range : "year"](localToday(), off);
}

const minDay = (a: PyDate, b: PyDate) => (a.n <= b.n ? a : b);

/** Free spending between two days, each with the service it went to. */
export async function rows(conn: Conn, a: PyDate, b: PyDate): Promise<SpendRow[]> {
  return (await transactionsRepo.spendRows(conn, a.isoformat(), b.isoformat())).map((r) => ({
    date: r.date, amount: pyRound(r.amount, 2), category: r.category,
    name: serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc),
  }));
}

const total = (rs: SpendRow[]) => pyRound(sum(rs.map((r) => r.amount)), 2);

function byCategory(rs: SpendRow[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const r of rs) {
    const c = out.get(r.category) ?? [0.0, 0];
    c[0] += r.amount; c[1] += 1;
    out.set(r.category, c);
  }
  return out;
}

async function firstDay(conn: Conn): Promise<PyDate | null> {
  const row = await transactionsRepo.oldestDay(conn);
  return row ? PyDate.fromisoformat(row) : null;
}

/** The periods before this one, each cut to `days` days when given; stops where data starts. */
async function past(conn: Conn, rng: string, off: number, count: number, days: number | null): Promise<SpendRow[][]> {
  const start = await firstDay(conn);
  const out = [];
  for (let k = 1; k <= count; k++) {
    const [a, b] = bounds(rng, off - k);
    if (!start || a.n < start.n) break;
    out.push(await rows(conn, a, days ? a.addDays(days - 1) : b));
  }
  return out;
}

/** Usual total and, per category, usual money and usual count. */
function usual(periods: SpendRow[][]): [number | null, Map<string, [number, number]>] {
  if (!periods.length) return [null, new Map()];
  const maps = periods.map(byCategory);
  const cats = new Set(maps.flatMap((m) => [...m.keys()]));
  const per = new Map<string, [number, number]>();
  for (const c of cats) per.set(c, [med(maps.map((m) => (m.get(c) ?? [0, 0])[0])), med(maps.map((m) => (m.get(c) ?? [0, 0])[1]))]);
  return [pyRound(med(periods.map(total)), 2), per];
}

function highlights(rs: SpendRow[], usualCats: Map<string, [number, number]>, days: Row[], elapsed: number, rules: Compared): Row[] {
  const now = byCategory(rs);
  const moves: Row[] = [];
  for (const c of sorted(new Set([...now.keys(), ...usualCats.keys()]))) {  // sorted: equal moves keep one order
    const [v, n] = now.get(c) ?? [0.0, 0];
    const [ua, uc] = usualCats.get(c) ?? [0.0, 0.0];
    const d = v - ua;
    if (Math.abs(d) >= rules.minMove && !(d < 0 && TIMED.has(c))) {
      moves.push({ kind: "category", category: c, spent: pyRound(v, 2), usual: pyRound(ua, 2), count: n, usual_count: HABITS.has(c) ? pyRound(uc) : null });
    }
  }
  const ups = sorted(moves.filter((m) => m.spent > m.usual), (m) => m.usual - m.spent);
  const downs = sorted(moves.filter((m) => m.spent < m.usual), (m) => m.spent - m.usual);
  const out: Row[] = [...ups.slice(0, 2), ...downs.slice(0, 1), ...ups.slice(2)].slice(0, 3);
  const t = total(rs);
  const big = maxBy(rs, (r) => r.amount);
  if (big && big.amount >= t * rules.bigPayment) out.push({ kind: "payment", ...big });
  if (rules.weekdays && elapsed >= 14) {
    const sums = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], counts = [0, 0, 0, 0, 0, 0, 0];
    for (const d of days) {
      if (d.spent != null) {
        const wd = PyDate.fromisoformat(d.date).weekday();
        sums[wd] += d.spent; counts[wd] += 1;
      }
    }
    const avg = sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
    const top = maxBy([0, 1, 2, 3, 4, 5, 6], (i) => avg[i])!;
    const overall = elapsed ? t / elapsed : 0;
    if (overall && avg[top] > overall * 1.6) out.push({ kind: "weekday", weekday: top, average: pyRound(avg[top], 2), overall: pyRound(overall, 2) });
  }
  out.push({ kind: "nospend", days: days.filter((d) => d.spent === 0).length, of: elapsed });
  return out;
}

function payments(rs: SpendRow[], limit?: number): SpendRow[] {
  const out = sorted(rs, (r) => [r.date, r.amount], true);
  return limit ? out.slice(0, limit) : out;
}

const daySpent = (rs: SpendRow[], d: PyDate) => pyRound(sum(rs.filter((r) => r.date === d.isoformat()).map((r) => r.amount)), 2);

export async function view(conn: Conn, rng: string, off: number): Promise<Row> {
  const today = localToday();
  const [a, b, key] = bounds(rng, off);
  const upto = minDay(b, today);
  const rs = a.n <= today.n ? await rows(conn, a, upto) : [];
  const t = total(rs);
  const partial = b.n > today.n;
  const elapsed = Math.max(0, upto.diffDays(a) + 1);
  const start = await firstDay(conn);
  const out: Row = {
    range: rng, off, key, start: a.isoformat(), end: b.isoformat(), today: today.isoformat(),
    partial, elapsed, length: b.diffDays(a) + 1, total: t, count: rs.length,
    can_prev: Boolean(start && bounds(rng, off - 1)[1].n >= start.n),
    can_next: off < 0,
  };
  if (rng === "year") return { ...out, ...(await yearView(conn, parseInt(key, 10), rs)) };

  const days = Array.from({ length: b.diffDays(a) + 1 }, (_, i) => a.addDays(i))
    .map((d) => ({ date: d.isoformat(), spent: d.n <= today.n ? daySpent(rs, d) : null }));
  if (rng === "day") {
    // The week the day sits in, and what this weekday usually comes to.
    const monday = a.addDays(-a.weekday());
    const weekRows = await rows(conn, monday, minDay(monday.addDays(6), today));
    const week = Array.from({ length: 7 }, (_, i) => monday.addDays(i))
      .map((d) => ({ date: d.isoformat(), spent: d.n <= today.n ? daySpent(weekRows, d) : null }));
    const totals = [];
    for (let k = 1; k <= USUAL_DAY_COUNT; k++) totals.push(total(await rows(conn, a.addDays(-7 * k), a.addDays(-7 * k))));
    return { ...out, week, usual: pyRound(med(totals), 2), payments: payments(rs) };
  }

  const rules = COMPARED[rng as keyof typeof COMPARED];
  const count = rules.usualCount;
  const last = await past(conn, rng, off, 1, partial ? elapsed : null);
  const [usualTotal, usualCats] = usual(await past(conn, rng, off, count, partial ? elapsed : null));
  const [fullUsual] = usual(await past(conn, rng, off, count, null));
  const trend = [];
  for (let k = rules.trendLength; k >= 0; k--) {
    const [ta, tb, tkey] = bounds(rng, off - k);
    if (start && ta.n < start.addDays(-31).n) continue;
    trend.push({ off: off - k, key: tkey, start: ta.isoformat(), total: total(await rows(conn, ta, minDay(tb, today))) });
  }
  return {
    ...out, days, trend, usual_full: fullUsual,
    last: last.length ? total(last[0]) : null, last_key: bounds(rng, off - 1)[2], usual: usualTotal,
    categories: sorted([...byCategory(rs).entries()].map(([c, [v, n]]) => ({
      category: c, spent: pyRound(v, 2), count: n, usual: pyRound((usualCats.get(c) ?? [0])[0], 2),
    })), (c) => -c.spent),
    highlights: highlights(rs, usualCats, days, elapsed, rules),
    payments: payments(rs),
  };
}

async function yearView(conn: Conn, year: number, rs: SpendRow[]): Promise<Row> {
  const today = localToday();
  const months: Row[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const [ma, mb] = monthBounds(key).map(PyDate.fromisoformat);
    if (ma.n > today.n) { months.push({ key, total: null, done: false }); continue; }
    const mrows = rs.filter((r) => ma.isoformat() <= r.date && r.date < mb.isoformat());
    months.push({ key, total: total(mrows), done: mb.n <= today.n, rows: mrows });
  }
  // The same usual month as the Month view: the median of the last six finished months.
  const usualMonth = usual(await past(conn, "month", 0, COMPARED.month.usualCount, null))[0] || 0;
  const done = months.filter((m) => m.done);
  const hl: Row[] = [];
  let standout = maxBy(done, (m) => m.total) ?? null;
  if (standout && usualMonth && standout.total > usualMonth * 1.5) {
    const lead = maxBy(byCategory(standout.rows).entries(), ([, v]) => v[0])!;
    hl.push({ kind: "month", month: standout.key, total: standout.total, usual: usualMonth, category: lead[0], amount: pyRound(lead[1][0], 2) });
  } else standout = null;
  // How each category moved: the last three finished months against the three before.
  if (done.length >= 6) {
    const avg = (ms: Row[]) => {
      const t = new Map<string, number>();
      for (const m of ms) for (const [c, [v]] of byCategory(m.rows)) t.set(c, (t.get(c) ?? 0) + v / ms.length);
      return t;
    };
    const before = avg(done.slice(-6, -3)), after = avg(done.slice(-3));
    const moves = sorted(new Set([...before.keys(), ...after.keys()])).map((c) => [c, Math.max(0.0, before.get(c) ?? 0), Math.max(0.0, after.get(c) ?? 0)] as [string, number, number]);
    for (const [c, x, y] of sorted(moves.filter((m) => Math.abs(m[2] - m[1]) >= 60), (m) => -Math.abs(m[2] - m[1])).slice(0, 3)) {
      hl.push({ kind: "trend", category: c, before: pyRound(x, 2), after: pyRound(y, 2), from: done[done.length - 3].key, to: done[done.length - 1].key });
    }
  }
  const big = maxBy(rs, (r) => r.amount);
  if (big && !(standout && standout.rows.includes(big))) hl.push({ kind: "payment", ...big });
  const heavy = done.filter((m) => usualMonth && m.total > usualMonth * 1.25 && (!standout || m.key !== standout.key)).map((m) => m.key);
  if (heavy.length) hl.push({ kind: "heavy_months", months: heavy, of: done.length });
  const started = months.filter((m) => m.total != null);
  return {
    months: months.map(({ rows: _, ...m }) => m), usual: pyRound(usualMonth, 2),
    categories: sorted([...byCategory(rs).entries()].map(([c, [v, n]]) => ({
      category: c, spent: pyRound(v, 2), count: n, per_month: pyRound(v / Math.max(1, started.length), 2),
    })), (c) => -c.spent),
    highlights: hl, payments: payments(sorted(rs, (r) => -r.amount).slice(0, 15)),
  };
}

/** One category over a period: its total, its usual month, six months of history, and who got it. */
export async function category(conn: Conn, cat: string, rng: string, off: number): Promise<Row> {
  const today = localToday();
  const [a, b, key] = bounds(rng, off);
  const rs = a.n <= today.n ? (await rows(conn, a, minDay(b, today))).filter((r) => r.category === cat) : [];
  const services = new Map<string, [number, number]>();
  for (const r of rs) {
    const s = services.get(r.name) ?? [0.0, 0];
    s[0] += r.amount; s[1] += 1;
    services.set(r.name, s);
  }
  const history = [];
  const month = monthOf(minDay(b, today));
  for (let k = 5; k >= 0; k--) {
    const m = shift(month, -k);
    const [ma, mb] = monthBounds(m).map(PyDate.fromisoformat);
    history.push({ key: m, total: total((await rows(conn, ma, minDay(mb.addDays(-1), today))).filter((r) => r.category === cat)) });
  }
  return {
    category: cat, range: rng, off, key, start: a.isoformat(), end: b.isoformat(), month,
    total: total(rs), count: rs.length, usual_month: pyRound(med(history.slice(0, -1).map((h) => h.total)), 2),
    history,
    services: sorted([...services.entries()].map(([n, [v, c]]) => ({ name: n, spent: pyRound(v, 2), count: c })), (s) => -s.spent),
  };
}

/** What Claude reads to explain a period: the numbers above and every payment in it. */
export async function context(conn: Conn, rng: string, off: number): Promise<string> {
  const v = await view(conn, rng, off);
  const lines = [`Period: ${rng} from ${v.start} to ${v.end}` + (v.partial ? ` (still going, ${v.elapsed} of ${v.length} days so far)` : "") + ".",
    `Free spending in it: €${fmt0(v.total)} over ${v.count} payments.`];
  if (rng !== "year") {
    if (v.last != null) lines.push(`The period before, ${v.partial ? "to the same point" : "in full"}: €${fmt0(v.last)}.`);
    if (v.usual != null) lines.push(`A usual ${rng}${v.partial ? " by this point" : ""} (median of the ones before): €${fmt0(v.usual)}.`);
    if (rng !== "day") {
      lines.push("By category (spent / usual / payments): " + v.categories.map((c: Row) => `${c.category} €${fmt0(c.spent)} / €${fmt0(c.usual)} / ${c.count}`).join("; "));
    }
  } else {
    lines.push(`A usual month: €${fmt0(v.usual)}. Months: ` + v.months.filter((m: Row) => m.total != null).map((m: Row) => `${m.key} €${fmt0(m.total)}`).join(", "));
    lines.push("By category (spent / per month): " + v.categories.map((c: Row) => `${c.category} €${fmt0(c.spent)} / €${fmt0(c.per_month)}`).join("; "));
  }
  const pays: SpendRow[] = rng !== "year" ? v.payments
    : payments(await rows(conn, PyDate.fromisoformat(v.start), minDay(PyDate.fromisoformat(v.end), localToday())));
  lines.push(`\nPayments (date, amount, category, service)${pays.length > 400 ? " - the 400 most recent" : ""}:`);
  for (const p of pays.slice(0, 400)) lines.push(`${p.date}, €${fmt2(p.amount)}, ${p.category}, ${p.name}`);
  return lines.join("\n");
}

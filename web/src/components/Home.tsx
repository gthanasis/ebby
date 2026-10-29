import { useEffect, useState, type ReactNode } from "react";
import { liveSync, patchGoal, saveSettings, setMonthLimit, startSync, useApi, type Home, type PayArrival, type PaydayGuess, type PayWait, type Status, type TodayMonth } from "../lib/api";
import { useAction } from "../lib/action";
import { ago, dayLabel, euroRound, monthLabel, ordinal, shiftMonth } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { FixedList } from "./Spending";
import { Card, CardHeader, Icon } from "./ui";

const DAYNAME = new Intl.DateTimeFormat("en-GB", { weekday: "long" });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const at = (d: string) => new Date(`${d}T12:00:00`);

/** Overview: how much of this month's budget is used and left, what a day can be from here to land on it (or
 * how to cover going over), and which fixed costs have gone out. */
export function HomeScreen({ byId, version, status, onSync }: ScreenProps & { status?: Status; onSync: () => void }) {
  const { data, error, reload } = useApi<Home>("/api/home", version);
  const syncing = status?.syncing ?? false;
  const m = data?.month;

  // Fresh data whenever the app is opened or brought back; the server limits it to every 15 minutes.
  useEffect(() => {
    const go = () => { if (document.visibilityState === "visible") liveSync().then((r) => { if (r.started) onSync(); }).catch(() => {}); };
    go();
    document.addEventListener("visibilitychange", go);
    return () => document.removeEventListener("visibilitychange", go);
  }, [onSync]);

  return (
    <>
      <header className="hello top">
        <div>
          <h1>{m ? DAYNAME.format(at(m.today)) : "Today"}</h1>
          <p>
            {m ? `${DATE.format(at(m.today))} · day ${m.elapsed}${data?.pay_waiting ? ", waiting for pay" : ` of ${m.length}`}` : "Loading…"}
            {m && !data?.pay_waiting ? ` · ${paydayIn(m)}` : ""}
            {syncing ? " · syncing…" : status?.last_sync ? ` · synced ${ago(data?.fresh_at ?? status.last_sync)}` : ""}
          </p>
        </div>
        <div className="chips">
          <button className="chip icon-only" aria-label="Sync now" disabled={syncing} onClick={() => startSync().then(onSync)}>
            <Icon icon="mdi:sync" className={syncing ? "spin" : ""} />
          </button>
        </div>
      </header>

      {error && <Card><div className="empty"><Icon icon="mdi:alert-circle-outline" />{error}</div></Card>}
      {!data && !error && <><div className="skeleton" /><div className="skeleton" /></>}
      {data && m && (
        <div className="col">
          {data.payday_hint && <PaydayNudge guess={data.payday_hint} onDone={reload} />}
          {data.pay_waiting && <PayWaiting wait={data.pay_waiting} m={m} />}
          {data.pay_arrived && <PayArrived pay={data.pay_arrived} />}
          {m.ideal ? (
            <>
              <MonthCard m={m} waiting={!!data.pay_waiting} />
              <GoalCard m={m} byId={byId} waiting={!!data.pay_waiting} onChanged={reload} />
            </>
          ) : <NoPlan m={m} />}
          <FixedCard m={m} />
        </div>
      )}
    </>
  );
}

/** Offered once: pay seems to land on the same day each month, so start the budget month there. */
function PaydayNudge({ guess, onDone }: { guess: PaydayGuess; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const save = (s: Parameters<typeof saveSettings>[0]) => { setBusy(true); saveSettings(s).then(onDone).finally(() => setBusy(false)); };
  return (
    <Card>
      <div className="status" style={{ marginTop: 0 }}>
        <Icon icon="mdi:calendar-month-outline" />
        <div>
          <b>Paid on the {ordinal(guess.day)}?</b>
          <p className="num">About {euroRound(guess.amount)} has arrived around the {ordinal(guess.day)} for {guess.months} months, last on {dayLabel(guess.last)}.
            Count your budget month from payday to payday.</p>
        </div>
      </div>
      <div className="row-actions">
        <button className="btn" disabled={busy} onClick={() => save({ payday: guess.day })}>Use the {ordinal(guess.day)}</button>
        <a className="chip" href={hrefFor({ page: "settings", section: "payday" })}>Another day</a>
        <button className="chip" disabled={busy} onClick={() => save({ payday_dismissed: true })}>Not now</button>
      </div>
    </Card>
  );
}

/** Pay is late: the month runs on past its last day until it lands. */
function PayWaiting({ wait, m }: { wait: PayWait; m: TodayMonth }) {
  return (
    <div className="notice warn" role="status">
      <Icon icon="mdi:timer-outline" />
      <div>
        <b>Waiting for your pay</b>
        <p className="num">{wait.payer ? `${wait.payer} usually pays` : "Your pay is usually"} about {euroRound(wait.amount)} on {SHORT.format(at(wait.expected))}. It hasn't
          arrived, so {monthLabel(m.month).split(" ")[0]}'s month stays open until it does, or until {WEEKDAY_SHORT.format(at(wait.until))}.</p>
        <a className="chip" href={hrefFor({ page: "settings", section: "payday" })}>Payday settings</a>
      </div>
    </div>
  );
}

function PayArrived({ pay }: { pay: PayArrival }) {
  return (
    <div className="notice ok" role="status">
      <Icon icon="mdi:arrow-down-circle-outline" />
      <div><b className="num">Pay arrived, {euroRound(pay.amount)}</b><p>A new month started on {WEEKDAY_SHORT.format(at(pay.date))}, the day it landed.</p></div>
    </div>
  );
}

/** Where this month stands against its budget, worked out once for every card. Fixed costs that came in over their
 * limits leave less to spend; what's spent is free spending only. */
function standing(m: TodayMonth, waiting: boolean) {
  const i = m.ideal!;
  const budget = i.budget;
  const fixedOver = Math.max(0, m.fixed.paid + m.fixed.due - i.fixed);
  const used = m.spent + fixedOver;
  const left = budget - used;
  const daysLeft = waiting ? 0 : m.length - m.elapsed;
  const usual = m.elapsed ? m.spent / m.elapsed : 0;
  const end = left - usual * daysLeft;
  const state: "ok" | "behind" | "over" = left < 0 ? "over" : end < 0 ? "behind" : "ok";
  const perDay = left <= 0 ? 0 : daysLeft ? left / daysLeft : left;
  return { budget, used, left, daysLeft, usual, end, state, perDay, pace: budget * m.elapsed / m.length };
}

/** Next month's budget was lowered to cover this one. */
const covered = (m: TodayMonth) => m.next_limit != null && m.ideal != null && m.next_limit < m.ideal.planned;

const paydayIn = (m: TodayMonth) => {
  const days = Math.round((at(m.end).getTime() - at(m.today).getTime()) / 864e5);
  return days <= 1 ? "payday tomorrow" : `payday in ${days} days`;
};

const STATE = {
  ok: { label: "On track", icon: "mdi:check-circle-outline" },
  behind: { label: "Behind", icon: "mdi:alert-circle-outline" },
  over: { label: "Over budget", icon: "mdi:alert-circle-outline" },
};

/** This month so far: used and left, the runway to payday, and the one number to live by from today. */
function MonthCard({ m, waiting }: { m: TodayMonth; waiting: boolean }) {
  const s = standing(m, waiting);
  const name = monthLabel(m.month).split(" ")[0];
  const days = s.daysLeft === 1 ? "1 day" : `${s.daysLeft} days`;
  return (
    <Card>
      <div className="ov-top">
        <div className="left-label">{name} so far</div>
        <span className={`ov-pill ${s.state}`}><Icon icon={STATE[s.state].icon} />{STATE[s.state].label}</span>
      </div>
      <div className="ov-duo num">
        <div><span>Used</span><b className={s.state === "over" ? "bad-txt" : ""}>{euroRound(s.used)}</b>
          <em>{Math.round((s.used / (s.budget || 1)) * 100)}% of {euroRound(s.budget)} · {euroRound(s.pace)} by today</em></div>
        <div><span>{s.left >= 0 ? "Left" : "Over"}</span><b className={s.state === "ok" ? "ok-txt" : s.state === "behind" ? "over-txt" : "bad-txt"}>{euroRound(Math.abs(s.left))}</b>
          <em>{waiting ? "until your pay lands" : s.left >= 0 ? `for ${days}` : `${days} still to go`}</em></div>
      </div>
      <Runway m={m} s={s} />
      <div className="ov-legend small muted">
        <span><i className={`ov-k actual ${s.state}`} />Left</span><span><i className="ov-k ideal" />On budget</span><span><i className={`ov-k proj ${s.state}`} />At this pace</span>
      </div>
      <div className={`ov-daily ${s.state} num`}>
        {s.state === "over" ? (
          <><span>The budget is used up</span><b>{euroRound(0)}<small> a day</small></b>
            <em>{euroRound(-s.left)} over already{s.daysLeft ? `, with ${days} to payday` : ""}.{" "}
              {covered(m) ? `Covered from ${monthLabel(shiftMonth(m.month, 1)).split(" ")[0]}.` : "Pick how to cover it below."}</em></>
        ) : (
          <><span>To land on budget</span><b>{euroRound(s.perDay)}<small> {s.daysLeft ? "a day" : waiting ? "until pay lands" : "today"}</small></b>
            <em>{s.daysLeft ? `for the ${days} to payday` : "for the rest of the month"}
              {s.state === "ok" ? `. You've been spending about ${euroRound(s.usual)} a day, so there's room.` : `, against the ${euroRound(s.usual)} a day you've been spending.`}</em></>
        )}
      </div>
    </Card>
  );
}

/** Money left each day from payday to payday: what's used is shaded, the straight line is on budget, the dotted line
 * carries on at the pace so far. Goes below zero when the month does. */
function Runway({ m, s }: { m: TodayMonth; s: ReturnType<typeof standing> }) {
  const W = 320, H = 150, P = 4, B = s.budget || 1;
  const lo = Math.max(-B * 0.3, Math.min(0, s.left - B * 0.05, s.end - B * 0.03));
  const x = (d: number) => P + (d / m.length) * (W - 2 * P);
  const y = (v: number) => P + ((B - v) / (B - lo)) * (H - 2 * P - 14);
  let left = B;
  const pts: [number, number][] = [[0, B], ...m.days.filter((d) => d.spent != null).map((d, i) => [i + 1, (left -= d.spent!)] as [number, number])];
  const line = pts.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const now = pts[pts.length - 1][0];
  const nowLeft = s.left;
  return (
    <svg className="ov-run" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${euroRound(s.used)} used of ${euroRound(B)}; at this pace ${s.end >= 0 ? `${euroRound(s.end)} left` : `${euroRound(-s.end)} over`} at payday`}>
      <polygon points={`${x(0)},${y(B)} ${line} ${x(now)},${y(B)}`} className="ov-used" />
      {lo < 0 && <>
        <rect x={P} y={y(0)} width={W - 2 * P} height={y(lo) - y(0)} className="ov-below" />
        <line x1={P} y1={y(0)} x2={W - P} y2={y(0)} className="ov-zero" />
      </>}
      <line x1={x(0)} y1={y(B)} x2={x(m.length)} y2={y(0)} className="ov-ideal" />
      <polyline points={line} className={`ov-actual ${s.state}`} />
      {s.daysLeft > 0 && <line x1={x(now)} y1={y(nowLeft)} x2={x(m.length)} y2={y(Math.max(lo, s.end))} className={`ov-proj ${s.state}`} />}
      <circle cx={x(now)} cy={y(nowLeft)} r={4} className={`ov-dot ${s.state}`} />
      <line x1={x(m.length)} y1={P} x2={x(m.length)} y2={H - 14} className="ov-payday" />
      <text x={x(0)} y={H - 1} className="ov-tx">{SHORT.format(at(m.start))}</text>
      {now / m.length > 0.15 && now / m.length < 0.8 && <text x={x(now)} y={H - 1} className="ov-tx" textAnchor="middle">today</text>}
      <text x={x(m.length)} y={H - 1} className="ov-tx" textAnchor="end">payday</text>
    </svg>
  );
}

/** What to do from here: on track, the category to watch and where the spare can go; behind, what to cut and what a
 * goal could cover; over, how to cover it, from next month or from a goal. */
function GoalCard({ m, byId, waiting, onChanged }: { m: TodayMonth; byId: ScreenProps["byId"]; waiting: boolean; onChanged: () => void }) {
  const s = standing(m, waiting);
  const i = m.ideal!;
  const goal = m.goal;
  const { busy, error, run } = useAction();
  const label = (c: string) => byId[c]?.label ?? c;
  const next = shiftMonth(m.month, 1);
  const nextName = monthLabel(next).split(" ")[0];
  // Taking goal money means more to spend this month; the goal gives it back from what it has saved.
  const fromGoal = (amount: number) => run(() => patchGoal(goal!.id, { add: -amount }).then(() => setMonthLimit(m.month, s.budget + amount)).then(onChanged));
  const rows: ReactNode[] = [];

  if (s.state === "ok") {
    const c = m.watch[0];
    if (c) rows.push(<Todo key="watch" icon={byId[c.category]?.icon} title={`${label(c.category)} is the one to watch`}
      note={`${euroRound(c.spent)} so far, ${euroRound(c.spent - c.usual)} over a usual month by now.`} />);
    if (s.daysLeft && s.end >= 20) {
      rows.push(goal
        ? <Todo key="spare" icon="mdi:piggy-bank-outline" tone="ok" title={`About ${euroRound(s.end)} spare at payday`}
            note={goal.saved + s.end >= goal.price
              ? `At this pace. That's enough to finish ${goal.name}: it needs ${euroRound(goal.price - goal.saved)} more.`
              : `At this pace. Put it towards ${goal.name} and you'd be at ${euroRound(goal.saved + s.end)} of ${euroRound(goal.price)}.`}
            aside={<a className="chip" href={hrefFor({ page: "goals" })}>Plan it</a>} />
        : <Todo key="spare" icon="mdi:piggy-bank-outline" tone="ok" title={`About ${euroRound(s.end)} spare at payday`}
            note="At this pace. A goal gives it somewhere to go." aside={<a className="chip" href={hrefFor({ page: "goals" })}>Add a goal</a>} />);
    }
    if (!rows.length) rows.push(<Todo key="keep" icon="mdi:check" tone="ok" title={`Keep to ${euroRound(s.perDay)} a day`} note="Nothing else to change." />);
  }

  if (s.state === "behind") {
    for (const c of m.watch) {
      const each = c.count ? c.spent / c.count : 0;
      rows.push(<Todo key={c.category} icon={byId[c.category]?.icon} tone="warn" title={`Cut ${label(c.category).toLowerCase()} this week`}
        note={`${euroRound(c.spent)} so far, ${euroRound(c.spent - c.usual)} over a usual month.${each >= 2 ? ` Each one fewer is about ${euroRound(each)}.` : ""}`} />);
    }
    const take = goal ? Math.min(goal.saved, Math.ceil(-s.end / 10) * 10) : 0;
    if (goal && take > 0 && s.daysLeft) {
      rows.push(<Todo key="goal" icon="mdi:piggy-bank-outline" title={`Or take ${euroRound(take)} from ${goal.name}`}
        note={`Then it's ${euroRound((s.left + take) / s.daysLeft)} a day instead of ${euroRound(s.perDay)}, and ${goal.name} has ${euroRound(goal.saved - take)} saved.`}
        aside={<button className="chip" disabled={busy} onClick={() => fromGoal(take)}>Use it</button>} />);
    }
    if (!rows.length) rows.push(<Todo key="keep" icon="mdi:wallet-outline" tone="warn" title={`Keep to ${euroRound(s.perDay)} a day`}
      note={`You've been at ${euroRound(s.usual)} a day. Spending is spread out, so there's no one thing to cut.`} />);
  }

  if (s.state === "over") {
    const over = Math.ceil(-s.left);
    if (covered(m)) {
      rows.push(<Todo key="next" icon="mdi:check" tone="ok" title={`${nextName} starts at ${euroRound(m.next_limit!)}`}
        note={`Instead of ${euroRound(i.planned)}, to cover this month.`} />);
    } else {
      rows.push(<Todo key="next" icon="mdi:calendar-month-outline" title={`Take ${euroRound(over)} from ${nextName}`}
        note={`${nextName} starts at ${euroRound(Math.max(0, i.planned - over))} instead of ${euroRound(i.planned)}. Nothing else changes.`}
        aside={<button className="chip" disabled={busy} onClick={() => run(() => setMonthLimit(next, Math.max(1, i.planned - over)).then(onChanged))}>Choose</button>} />);
      if (goal && goal.saved >= over) {
        rows.push(<Todo key="goal" icon="mdi:piggy-bank-outline" title={`Or cover it from ${goal.name}`}
          note={`${euroRound(over)} of the ${euroRound(goal.saved)} saved.`}
          aside={<button className="chip" disabled={busy} onClick={() => fromGoal(over)}>Choose</button>} />);
      }
    }
    const groceries = m.categories.find((c) => c.category === "groceries");
    if (s.daysLeft) rows.push(<Todo key="essentials" icon="mdi:cart-outline" tone="bad" title="Until payday: essentials only"
      note={groceries && m.elapsed ? `Groceries have been about ${euroRound(groceries.spent / m.elapsed)} a day. Anything more adds to what's over.` : "Anything more adds to what's over."} />);
  }

  return (
    <Card>
      <CardHeader icon="mdi:target" title={s.state === "over" ? "Get back on track" : "To hit your goal"} />
      {rows}
      {error && <div className="error">{error}</div>}
    </Card>
  );
}

function Todo({ icon, tone = "", title, note, aside }: { icon?: string; tone?: string; title: string; note: string; aside?: ReactNode }) {
  return (
    <div className="part">
      <span className={`ricon ${tone}`}><Icon icon={icon ?? "mdi:dots-horizontal"} /></span>
      <span className="t"><b>{title}</b><span className="muted small text-wrap">{note}</span></span>
      {aside}
    </div>
  );
}

/** Before there's a plan: what's spent, and the one step that turns on the rest of the page. */
function NoPlan({ m }: { m: TodayMonth }) {
  return (
    <Card>
      <div className="left-label">{monthLabel(m.month).split(" ")[0]} so far</div>
      <div className="left-num num">{euroRound(m.spent)}</div>
      <p className="hint">Add your monthly income to see what's left, and what a day can be until payday.</p>
      <div className="row-actions"><a className="chip" href={hrefFor({ page: "settings", section: "income" })}>Add income</a></div>
    </Card>
  );
}

/** Every fixed cost this month: paid, with the day, or still to come. */
function FixedCard({ m }: { m: TodayMonth }) {
  return (
    <Card>
      <CardHeader icon="mdi:repeat" title="Fixed costs"
        aside={m.fixed.items.length ? <span className="small muted num">{euroRound(m.fixed.paid)} of {euroRound(m.fixed.expected)} paid</span> : undefined} />
      {m.fixed.items.length ? <FixedList f={m.fixed} month={m.month} bare /> : (
        <p className="hint" style={{ margin: 0 }}>Rent, bills and loans you pay every month. <a className="link" href={hrefFor({ page: "settings", section: "fixed" })}>Add them</a></p>
      )}
      {m.fixed.items.length > 0 && <p className="hint">Set aside before your budget, so they don't change what's left to spend.</p>}
    </Card>
  );
}

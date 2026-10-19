import { Fragment, useEffect, useState } from "react";
import { liveSync, saveSettings, startSync, useApi, type Home, type PaydayGuess, type Status, type TodayMonth } from "../lib/api";
import { useRemembered } from "../lib/remember";
import { ago, dayLabel, euroRound, ordinal } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { Card, CardHeader, Icon } from "./ui";

const DAYNAME = new Intl.DateTimeFormat("en-GB", { weekday: "long" });
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const WEEKDAY_SHORT = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const at = (d: string) => new Date(`${d}T12:00:00`);

/** Today: how this pay month is going so far. The average day, where the month ends at that pace,
 * the days week by week, and where the money went. */
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
            {m ? `${DATE.format(at(m.today))} · day ${m.elapsed} of ${m.length}` : "Loading…"}
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
          <TodayCards m={m} byId={byId} />
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

type Mode = "now" | "ideal";

/** Now is how the month is going; Ideal is how it should go on the budget. One switch for both cards. */
function TodayCards({ m, byId }: { m: TodayMonth; byId: ScreenProps["byId"] }) {
  const [saved, setMode] = useRemembered<Mode>("todayMode", "now");
  const mode: Mode = m.ideal ? saved : "now";
  return (
    <>
      <SpendCard m={m} mode={mode} setMode={setMode} />
      <WhereItWent m={m} byId={byId} mode={mode} />
    </>
  );
}

interface Week { from: number; to: number; total: number; future: boolean }

/** Monday-to-Sunday runs over the days of the pay month; the first and last can be short. */
function weeksOf(days: TodayMonth["days"]): Week[] {
  const out: Week[] = [];
  days.forEach((d, i) => {
    if (i === 0 || at(d.date).getDay() === 1) out.push({ from: i, to: i, total: 0, future: true });
    const w = out[out.length - 1];
    w.to = i;
    if (d.spent != null) { w.total += d.spent; w.future = false; }
  });
  return out;
}

function SpendCard({ m, mode, setMode }: { m: TodayMonth; mode: Mode; setMode: (m: Mode) => void }) {
  const ideal = mode === "ideal" && m.ideal ? m.ideal : null;
  const past = m.days.map((d, i) => ({ ...d, i })).filter((d) => d.spent != null) as { date: string; spent: number; i: number }[];
  const spending = past.filter((d) => d.spent > 0);
  const max = spending.reduce<(typeof spending)[0] | null>((a, d) => (!a || d.spent > a.spent ? d : a), null);
  const min = spending.reduce<(typeof spending)[0] | null>((a, d) => (!a || d.spent < a.spent ? d : a), null);
  const none = past.filter((d) => d.spent === 0 && d.date !== m.today).length;
  const lastDay = m.days[m.days.length - 1].date;

  return (
    <Card>
      {m.ideal && (
        <div className="seg2" role="radiogroup" aria-label="Show">
          <button role="radio" aria-checked={!ideal} onClick={() => setMode("now")}>Now</button>
          <button role="radio" aria-checked={!!ideal} onClick={() => setMode("ideal")}>Ideal</button>
        </div>
      )}
      {ideal ? (
        <div className="td-duo">
          <div>
            <div className="left-label">Ideal day</div>
            <div className="td-n num">{euroRound(ideal.day)}</div>
            <div className="td-s">to land on budget</div>
          </div>
          <div>
            <div className="left-label">Month should end at</div>
            <div className="td-n num">{euroRound(ideal.budget)}</div>
            <div className="td-s">your budget</div>
          </div>
        </div>
      ) : (
        <div className="td-duo">
          <div>
            <div className="left-label">Average day</div>
            <div className="td-n num">{euroRound(m.average)}</div>
            <div className="td-s num">over {m.elapsed} {m.elapsed === 1 ? "day" : "days"}</div>
          </div>
          <div>
            <div className="left-label">Month ends at</div>
            <div className="td-n num">{euroRound(m.projected)}</div>
            <div className="td-s num">at this pace, {SHORT.format(at(lastDay))}</div>
          </div>
        </div>
      )}
      <WeekChart m={m} idealDay={ideal?.day} maxIndex={max?.i} minIndex={min && min !== max ? min.i : undefined} />
      {ideal ? <BudgetSum m={m} /> : max && (
        <div className="td-extremes num">
          <div><span><i className="td-dot hot" />Biggest day</span><b>{euroRound(max.spent)}</b><em>{WEEKDAY_SHORT.format(at(max.date))}</em></div>
          {min && min !== max && <div><span><i className="td-dot low" />Smallest day</span><b>{euroRound(min.spent)}</b><em>{WEEKDAY_SHORT.format(at(min.date))}</em></div>}
        </div>
      )}
      {!ideal && none > 0 && <p className="td-note">{none} {none === 1 ? "day" : "days"} with nothing spent.</p>}
    </Card>
  );
}

/** Where the budget comes from: income, less savings, fixed costs and each goal's month. */
function BudgetSum({ m }: { m: TodayMonth }) {
  const i = m.ideal!;
  const left = i.budget - m.spent;
  return (
    <>
      <div className="sum num td-sum">
        <span>Income</span><b>{euroRound(i.income)}</b>
        <span>Savings</span><b>−{euroRound(i.savings)}</b>
        <span>Fixed costs</span><b>−{euroRound(i.fixed)}</b>
        {i.goals.length ? i.goals.map((g) => (
          <Fragment key={g.name}>
            <span><a className="td-goal" href={hrefFor({ page: "goals" })}>{g.name}, {euroRound(g.price)} by {SHORT.format(at(g.target_date))}</a></span>
            <b>−{euroRound(g.monthly)}</b>
          </Fragment>
        )) : <><span>Goals</span><b><a className="link" href={hrefFor({ page: "goals" })}>Add one</a></b></>}
        <span className="tot">Budget</span><b className="tot">{euroRound(i.budget)} a month</b>
      </div>
      <p className={`td-note num ${left < 0 ? "over-txt" : ""}`}>
        {euroRound(m.spent)} spent so far, {left < 0 ? `${euroRound(-left)} over the budget.` : `${euroRound(left)} left.`}
      </p>
    </>
  );
}

/** One bar per day, the average drawn through them, weeks divided with each week's total under it. */
function WeekChart({ m, idealDay, maxIndex, minIndex }: { m: TodayMonth; idealDay?: number; maxIndex?: number; minIndex?: number }) {
  // In Ideal the line is the budget's day and each week is measured against its share of it.
  const line = idealDay ?? m.average;
  const weeks = weeksOf(m.days);
  const todayIndex = m.days.findIndex((d) => d.date === m.today);
  const thisWeek = weeks.findIndex((w) => todayIndex >= w.from && todayIndex <= w.to);
  const top = Math.max(line, ...m.days.map((d) => d.spent ?? 0), 1) * 1.08;
  const cols = { gridTemplateColumns: `repeat(${m.days.length}, 1fr)` };
  const span = (w: Week) => ({ gridColumn: `${w.from + 1} / ${w.to + 2}` });

  return (
    <div className="td-chart" role="img" aria-label={`Spending per day this month; ${weeks.filter((w) => !w.future).map((w) => `${euroRound(w.total)} the week of ${SHORT.format(at(m.days[w.from].date))}`).join(", ")}`}>
      <div className="td-plot">
        <div className="td-bands" style={cols}>
          {weeks.map((w, k) => <span key={w.from} className={`${k === thisWeek ? "now" : ""} ${k ? "div" : ""}`} style={span(w)} />)}
        </div>
        <div className="td-bars" style={cols}>
          {m.days.map((d, i) => d.spent == null
            ? <i key={d.date} className="future" style={{ height: `${(line / top) * 100}%` }} />
            : <i key={d.date} title={`${SHORT.format(at(d.date))}: ${euroRound(d.spent)}`}
                className={idealDay != null ? (d.spent > idealDay ? "over" : "") : i === maxIndex ? "max" : i === minIndex ? "min" : i === todayIndex ? "today" : ""}
                style={{ height: `${Math.max(3, (d.spent / top) * 100)}%` }} />)}
          <span className={`td-avg ${idealDay != null ? "ideal" : ""}`} style={{ bottom: `${(line / top) * 100}%` }}>
            <em className="num">{euroRound(line)} {idealDay != null ? "ideal" : "a day"}</em>
          </span>
        </div>
      </div>
      <div className="td-weeks" style={cols}>
        {weeks.map((w, k) => {
          const narrow = w.to - w.from < 4;
          const share = (idealDay ?? 0) * (w.to - w.from + 1);
          return (
            <span key={w.from} className={`${k === thisWeek ? "now" : ""} ${w.future ? "future" : ""} ${k ? "div" : ""}`} style={span(w)}>
              {idealDay != null
                ? w.future ? <><b className="num">{euroRound(share)}</b>left</>
                  : <><b className={`num ${w.total > share ? "over-txt" : ""}`}>{euroRound(w.total)}</b>{narrow ? "" : `of ${euroRound(share)}`}</>
                : w.future ? <><b>{w.to - w.from + 1} days</b>to go</>
                  : <><b className="num">{euroRound(w.total)}</b>{k === thisWeek ? "this week" : narrow ? at(m.days[w.from].date).getDate() : SHORT.format(at(m.days[w.from].date))}</>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** This month's spending by category, biggest first; each opens its drill-down. */
function WhereItWent({ m, byId, mode }: { m: TodayMonth; byId: ScreenProps["byId"]; mode: Mode }) {
  const [all, setAll] = useState(false);
  const targets = mode === "ideal" ? m.ideal?.targets : undefined;
  // In Ideal the bars share one scale with the targets, so a tick shows where each should stop.
  const top = Math.max(m.categories[0]?.spent ?? 0, ...(targets ? m.categories.map((c) => targets[c.category] ?? 0) : []));
  const shown = all ? m.categories : m.categories.slice(0, 6);
  return (
    <Card>
      <CardHeader icon="mdi:chart-donut" title="Where it went"
        aside={<a className="link" href={hrefFor({ page: "spending", range: "month" })}>Spending<Icon icon="mdi:chevron-right" /></a>} />
      {m.categories.length === 0 && <p className="hint" style={{ margin: 0 }}>Nothing spent yet this month.</p>}
      {shown.map((c) => {
        const cat = byId[c.category];
        const target = targets ? targets[c.category] ?? 0 : null;
        const over = target != null && c.spent > target;
        return (
          <a key={c.category} className="part td-cat" href={hrefFor({ page: "category", category: c.category, range: "month" })}>
            <span className="ricon"><Icon icon={cat?.icon ?? "mdi:dots-horizontal"} /></span>
            <span className="t">
              <b>{cat?.label ?? c.category}<small className="num">{c.count} {c.count === 1 ? "payment" : "payments"}</small></b>
              <span className="td-share">
                <i className={over ? "over" : ""} style={{ width: `${top ? (c.spent / top) * 100 : 0}%` }} />
                {target != null && <u style={{ left: `${top ? (target / top) * 100 : 0}%` }} />}
              </span>
            </span>
            <span className="amt num">
              <b className={over ? "over-txt" : ""}>{euroRound(c.spent)}</b>
              <span>{target != null ? `of ${euroRound(target)}` : `${m.spent ? Math.round((c.spent / m.spent) * 100) : 0}%`}</span>
            </span>
            <Icon icon="mdi:chevron-right" />
          </a>
        );
      })}
      {m.categories.length > 6 && (
        <button className="part add-row" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${m.categories.length}`}</button>
      )}
    </Card>
  );
}

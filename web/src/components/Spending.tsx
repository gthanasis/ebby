import { useEffect, useState, type ReactNode } from "react";
import { explainPeriod, useApi, type Explanation, type Highlight, type Range, type SpendDay, type SpendPayment, type SpendView } from "../lib/api";
import { euro, euroRound, monthLabel, shiftMonth, thisMonth } from "../lib/format";
import { useRemembered } from "../lib/remember";
import { hrefFor, type ScreenProps } from "./App";
import { Card, ErrorNote, Icon } from "./ui";

export function SpendingTabs({ current, month }: { current: "categories" | "subscriptions" | "transactions"; month: string }) {
  const tabs = [
    { id: "categories", label: "Spending", href: hrefFor({ page: "spending", month }) },
    { id: "subscriptions", label: "Subscriptions", href: hrefFor({ page: "subscriptions" }) },
    { id: "transactions", label: "All payments", href: hrefFor({ page: "transactions", month }) },
  ] as const;
  return (
    <nav className="pills tabs" aria-label="Spending views">
      {tabs.map((t) => (
        <a key={t.id} className={`pill ${current === t.id ? "sel" : ""}`} aria-current={current === t.id ? "page" : undefined} href={t.href}>{t.label}</a>
      ))}
    </nav>
  );
}

export function MonthNav({ month, go }: { month: string; go: ScreenProps["go"] }) {
  return (
    <div className="chips">
      <button className="chip icon-only" aria-label="Previous month" onClick={() => go({ month: shiftMonth(month, -1) })}><Icon icon="mdi:chevron-left" /></button>
      <button className="chip icon-only" aria-label="Next month" disabled={month >= thisMonth()} onClick={() => go({ month: shiftMonth(month, 1) })}><Icon icon="mdi:chevron-right" /></button>
    </div>
  );
}

const at = (d: string) => new Date(`${d}T12:00:00`);
const fmt = (d: string, o: Intl.DateTimeFormatOptions) => at(d).toLocaleDateString("en-GB", o);
const SHORT: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const RANGES: Range[] = ["day", "week", "month", "year"];
const HABIT: Record<string, string> = { delivery: "orders", eating_out: "meals out", coffee_bars: "coffees", people: "transfers", groceries: "shops" };
const daysBetween = (from: string, to: string) => Math.round((at(to).getTime() - at(from).getTime()) / 864e5);
const monthOff = (key: string) => {
  const [y, m] = key.split("-").map(Number), [ty, tm] = thisMonth().split("-").map(Number);
  return (y - ty) * 12 + (m - tm);
};

/** Spending: pick a day, week, pay month or year and see what happened, against the one before and
 * against your usual. Categories drill down to services and payments; search covers everything. */
export function Spending({ byId, version, go, range, off }: ScreenProps & { range: Range; off: number }) {
  const { data, error, reload } = useApi<SpendView>(`/api/spending?range=${range}&off=${off}`, version);
  const v = data && data.range === range && data.off === off ? data : undefined;
  const set = (r: { range?: Range; off?: number }) => go({ page: "spending", range: r.range ?? range, off: r.off ?? off });

  return (
    <>
      <header className="hello top">
        <div><h1>Spending</h1></div>
        <a className="chip icon-only" aria-label="Search payments" href={hrefFor({ page: "transactions" })}><Icon icon="mdi:magnify" /></a>
      </header>
      <div className="sp-seg" role="tablist" aria-label="Period">
        {RANGES.map((r) => (
          <button key={r} role="tab" aria-selected={r === range} onClick={() => set({ range: r, off: 0 })}>{r[0].toUpperCase() + r.slice(1)}</button>
        ))}
      </div>
      <div className="sp-nav">
        <button className="chip icon-only" aria-label={`Previous ${range}`} disabled={!v?.can_prev} onClick={() => set({ off: off - 1 })}><Icon icon="mdi:chevron-left" /></button>
        <div>{v ? <><b>{RANGE[v.range].title(v)}</b><small>{RANGE[v.range].subtitle(v)}</small></> : <b>&nbsp;</b>}</div>
        <button className="chip icon-only" aria-label={`Next ${range}`} disabled={off >= 0} onClick={() => set({ off: off + 1 })}><Icon icon="mdi:chevron-right" /></button>
      </div>
      {error && <div className="error">{error}</div>}
      {!v && !error && <div className="skeleton" />}
      {v && (range === "day"
        ? <DayView v={v} byId={byId} onPick={(d) => set({ off: daysBetween(v.today, d) })} />
        : <PeriodView v={v} byId={byId} onPick={set} onExplained={reload} />)}
    </>
  );
}

const span = (v: SpendView) => `${fmt(v.start, SHORT)} – ${fmt(v.end, SHORT)}`;
const monthsIn = (v: SpendView) => v.months?.filter((m) => m.total != null).length ?? 0;
const lastMonth = (v: SpendView) => v.last_key ? monthLabel(v.last_key).split(" ")[0] : "";
const paymentsTab = (v: SpendView) => `Payments · ${v.count}`;

/** How each range names itself: the header, the period before it, the "so far" caption and the tab labels. */
const RANGE: Record<Range, {
  title: (v: SpendView) => string; subtitle: (v: SpendView) => string;
  /** The period before, for "€40 more than …". */
  lastName: (v: SpendView) => string;
  /** Under the total while the period is still running. */
  soFar: (v: SpendView) => string;
  /** The chart tab that steps through past periods. */
  trend: string;
  paymentsTab: (v: SpendView) => string;
  /** "Explain this week" */
  explain: string;
}> = {
  day: {
    title: (v) => v.off === 0 ? "Today" : v.off === -1 ? "Yesterday" : fmt(v.start, { weekday: "long" }),
    subtitle: (v) => fmt(v.start, { day: "numeric", month: "long" }),
    lastName: lastMonth, soFar: () => "so far", trend: "Months", paymentsTab, explain: "this day",
  },
  week: {
    title: (v) => v.off === 0 ? "This week" : v.off === -1 ? "Last week" : `Week of ${fmt(v.start, SHORT)}`,
    subtitle: span,
    lastName: (v) => v.off === 0 ? "last week" : "the week before", soFar: () => "so far", trend: "Weeks", paymentsTab, explain: "this week",
  },
  month: {
    title: (v) => monthLabel(v.key).split(" ")[0] + (v.key.slice(0, 4) === thisMonth().slice(0, 4) ? "" : ` ${v.key.slice(0, 4)}`),
    subtitle: span,
    lastName: lastMonth, soFar: (v) => `so far, day ${v.elapsed} of ${v.length}`, trend: "Months", paymentsTab, explain: "this month",
  },
  year: {
    title: (v) => v.key,
    subtitle: (v) => `${monthsIn(v)} pay months`,
    lastName: lastMonth, soFar: (v) => `so far, ${monthsIn(v)} months`, trend: "Months", paymentsTab: () => "Biggest", explain: "this year",
  },
};

/** "€118 less than last week (€718)", the difference coloured; "about the same" when close. */
function compare(value: number, base: number, name: string, close = 10): ReactNode {
  if (Math.abs(value - base) < close) return <>about the same as {name} ({euroRound(base)})</>;
  return <><b className={value > base ? "over-txt" : "ok-txt"}>{euroRound(Math.abs(value - base))} {value > base ? "more" : "less"}</b> than {name} ({euroRound(base)})</>;
}

/* ---------- day ---------- */

function DayView({ v, byId, onPick }: { v: SpendView; byId: ScreenProps["byId"]; onPick: (date: string) => void }) {
  const weekday = WEEKDAYS[(at(v.start).getDay() + 6) % 7];
  const usual = v.usual ?? 0;
  const line = v.start === v.today && v.count === 0 ? <>Nothing yet today. Card payments usually show up a day later.</>
    : v.count === 0 ? <>Nothing spent. A usual {weekday} is {euroRound(usual)}.</>
    : <>{compare(v.total, usual, `a usual ${weekday}`, 5)}.</>;
  return (
    <div className="col">
      <Card>
        <div className="sp-total num">{euroRound(v.total)}{v.count > 0 && <small>{v.count} {v.count === 1 ? "payment" : "payments"}</small>}</div>
        <p className="sp-line num">{line}</p>
        <WeekStrip days={v.week ?? []} picked={v.start} onPick={onPick} />
      </Card>
      {v.payments.length > 0 && (
        <>
          <div className="group-label">{v.count} {v.count === 1 ? "payment" : "payments"}</div>
          <Card className="list"><PaymentRows rows={[...v.payments].sort((a, b) => b.amount - a.amount)} byId={byId} /></Card>
        </>
      )}
    </div>
  );
}

/** Seven days with their bars, the picked one highlighted; tap one to open it. */
function WeekStrip({ days, picked, onPick, amounts }: { days: SpendDay[]; picked?: string; onPick: (d: string) => void; amounts?: boolean }) {
  const top = Math.max(1, ...days.map((d) => d.spent ?? 0));
  return (
    <div className="sp-strip">
      {days.map((d) => (
        <button key={d.date} className={d.date === picked ? "on" : ""} disabled={d.spent == null} onClick={() => onPick(d.date)}
          aria-label={`${fmt(d.date, { weekday: "long", day: "numeric", month: "long" })}${d.spent != null ? `, ${euroRound(d.spent)}` : ""}`}>
          <span className="sp-day"><i style={{ height: `${d.spent == null ? 0 : Math.max(4, (d.spent / top) * 100)}%` }} /></span>
          <span className="lbl">{fmt(d.date, { weekday: "narrow" })}<b>{at(d.date).getDate()}</b></span>
          {amounts && <span className="lbl num">{d.spent == null ? "" : euroRound(d.spent)}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------- week, month and year ---------- */

type Tab = "highlights" | "categories" | "payments";

function PeriodView({ v, byId, onPick, onExplained }: {
  v: SpendView; byId: ScreenProps["byId"]; onPick: (r: { range?: Range; off?: number }) => void; onExplained: () => void;
}) {
  const [tab, setTab] = useRemembered<Tab>("spendingTab", "highlights");
  const [chart, setChart] = useRemembered<"days" | "trend">("spendingChart", "days");
  const year = v.range === "year";
  const unit = v.range;
  const named = RANGE[v.range];
  const by = v.partial ? " by this point" : "";

  return (
    <div className="col">
      <Card>
        <div className="sp-total num">{euroRound(v.total)}
          {v.partial && <small>{named.soFar(v)}</small>}
        </div>
        {year ? <p className="sp-line num">A usual month is <b>{euroRound(v.usual)}</b>.{standout(v)}</p>
          : (v.last != null || v.usual != null) && (
            <p className="sp-line num">
              {v.last != null && compare(v.total, v.last, `${named.lastName(v)}${by}`)}
              {v.last != null && v.usual != null && ", and "}
              {v.usual != null && compare(v.total, v.usual, `a usual ${unit}${by}`)}.
            </p>
          )}
        {!year && (
          <div className="sp-mini" role="tablist" aria-label="Chart">
            <button role="tab" aria-selected={chart === "days"} onClick={() => setChart("days")}>Days</button>
            <button role="tab" aria-selected={chart === "trend"} onClick={() => setChart("trend")}>{named.trend}</button>
          </div>
        )}
        {year ? <YearChart v={v} onPick={(key) => onPick({ range: "month", off: monthOff(key) })} />
          : chart === "days" ? <DaysChart v={v} onPick={(d) => onPick({ range: "day", off: daysBetween(v.today, d) })} />
          : <TrendChart v={v} onPick={(o) => onPick({ off: o })} />}
      </Card>
      <div className="sp-tabs" role="tablist" aria-label="Show">
        {(["highlights", "categories", "payments"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
            {t === "highlights" ? "Highlights" : t === "categories" ? "Categories" : named.paymentsTab(v)}
          </button>
        ))}
      </div>
      {tab === "highlights" && (
        <Card>
          {(v.highlights ?? []).map((h, i) => <HighlightRow key={i} h={h} unit={`${unit}${v.range === "month" ? by : ""}`} byId={byId} />)}
          {v.ai && <Explain v={v} onDone={onExplained} />}
        </Card>
      )}
      {tab === "categories" && <Categories v={v} byId={byId} />}
      {tab === "payments" && (
        v.payments.length === 0 ? <Card><div className="empty">No payments.</div></Card>
          : year ? (
            <>
              <div className="group-label">The {v.payments.length} biggest payments this year</div>
              <Card className="list"><PaymentRows rows={v.payments} byId={byId} withDate /></Card>
              <a className="btn ghost block" href={hrefFor({ page: "transactions" })}><Icon icon="mdi:magnify" />Search all {v.count} payments</a>
            </>
          ) : <PaymentDays rows={v.payments} byId={byId} />
      )}
    </div>
  );
}

function standout(v: SpendView): ReactNode {
  const h = v.highlights?.find((x) => x.kind === "month");
  return h && h.kind === "month" ? <> {monthLabel(h.month).split(" ")[0]} stands out at <b className="over-txt">{euroRound(h.total)}</b>.</> : null;
}

function DaysChart({ v, onPick }: { v: SpendView; onPick: (date: string) => void }) {
  const days = v.days ?? [];
  if (v.range === "week") return <WeekStrip days={days} onPick={onPick} amounts />;
  const avg = v.elapsed ? v.total / v.elapsed : 0;
  const top = Math.max(avg, ...days.map((d) => d.spent ?? 0), 1) * 1.08;
  return (
    <Bars n={days.length} labels={days.map((d, i) => (i === 0 || at(d.date).getDate() % 5 === 0 ? String(at(d.date).getDate()) : ""))}
      line={{ value: avg / top, label: `${euroRound(avg)} a day` }}>
      {days.map((d) => d.spent == null ? <i key={d.date} className="future" />
        : <button key={d.date} className={d.date === v.today ? "cur" : ""} style={{ height: `${Math.max(2, (d.spent / top) * 100)}%` }}
            onClick={() => onPick(d.date)} aria-label={`${fmt(d.date, SHORT)}, ${euroRound(d.spent)}`} />)}
    </Bars>
  );
}

function TrendChart({ v, onPick }: { v: SpendView; onPick: (off: number) => void }) {
  const list = v.trend ?? [];
  const top = Math.max(v.usual_full ?? 0, ...list.map((t) => t.total), 1) * 1.05;
  return (
    <Bars n={list.length} labels={list.map((t) => v.range === "week" ? `${at(t.start).getDate()}/${at(t.start).getMonth() + 1}` : fmt(`${t.key}-15`, { month: "narrow" }))}
      line={v.usual_full ? { value: v.usual_full / top, label: `usual ${euroRound(v.usual_full)}` } : undefined}>
      {list.map((t) => (
        <button key={t.off} className={t.off === v.off ? "cur" : ""} style={{ height: `${Math.max(2, (t.total / top) * 100)}%` }}
          onClick={() => onPick(t.off)} aria-label={`${t.key}, ${euroRound(t.total)}`} />
      ))}
    </Bars>
  );
}

function YearChart({ v, onPick }: { v: SpendView; onPick: (key: string) => void }) {
  const months = v.months ?? [];
  const hot = v.highlights?.find((h) => h.kind === "month");
  const top = Math.max(v.usual ?? 0, ...months.map((m) => m.total ?? 0), 1) * 1.05;
  return (
    <Bars n={12} labels={months.map((m) => fmt(`${m.key}-15`, { month: "narrow" }))}
      line={v.usual ? { value: v.usual / top, label: `usual ${euroRound(v.usual)}` } : undefined}>
      {months.map((m) => m.total == null ? <i key={m.key} className="future" />
        : <button key={m.key} className={`${m.done ? "" : "cur"} ${hot && hot.kind === "month" && hot.month === m.key ? "hot" : ""}`}
            style={{ height: `${Math.max(2, (m.total / top) * 100)}%` }} onClick={() => onPick(m.key)} aria-label={`${monthLabel(m.key)}, ${euroRound(m.total)}`} />)}
    </Bars>
  );
}

function Bars({ n, labels, line, children }: { n: number; labels: string[]; line?: { value: number; label: string }; children: ReactNode }) {
  const cols = { gridTemplateColumns: `repeat(${n}, 1fr)` };
  return (
    <div className="sp-chart">
      <div className="sp-bars" style={cols}>
        {children}
        {line && <span className="sp-ref" style={{ bottom: `${line.value * 100}%` }}><em className="num">{line.label}</em></span>}
      </div>
      <div className="sp-x" style={cols}>{labels.map((l, i) => <span key={i}>{l}</span>)}</div>
    </div>
  );
}

/* ---------- highlights ---------- */

function HighlightRow({ h, unit, byId }: { h: Highlight; unit: string; byId: ScreenProps["byId"] }) {
  const name = (c: string) => byId[c]?.label ?? c;
  let icon = "mdi:calendar-month-outline";
  let text: ReactNode;
  switch (h.kind) {
    case "category": {
      icon = byId[h.category]?.icon ?? icon;
      const more = h.spent > h.usual;
      text = <><b>{name(h.category)} {euroRound(h.spent)}</b>, <span className={more ? "over-txt" : "ok-txt"}>{euroRound(Math.abs(h.spent - h.usual))} {more ? "more" : "less"}</span> than a usual {unit}
        {h.usual_count != null && h.count !== h.usual_count ? `, ${h.count} ${HABIT[h.category] ?? "payments"} against a usual ${h.usual_count}` : ""}.</>;
      break;
    }
    case "payment":
      icon = byId[h.category]?.icon ?? icon;
      text = <><b>{euroRound(h.amount)}, {h.name}</b> on {fmt(h.date, { weekday: "long", day: "numeric", month: "short" })}, the biggest single payment.</>;
      break;
    case "weekday":
      text = <><b>{WEEKDAYS[h.weekday]}s are your heaviest day</b>, about {euroRound(h.average)} against {euroRound(h.overall)} on an average day.</>;
      break;
    case "nospend":
      text = h.days ? <><b>{h.days} {h.days === 1 ? "day" : "days"} with nothing spent</b> out of {h.of}.</> : <>Something spent every day.</>;
      break;
    case "month":
      icon = byId[h.category]?.icon ?? icon;
      text = <><b>{monthLabel(h.month).split(" ")[0]} was {euroRound(h.total)}</b>, {euroRound(h.total - h.usual)} over a usual month. {euroRound(h.amount)} of it was {name(h.category).toLowerCase()}.</>;
      break;
    case "trend": {
      icon = byId[h.category]?.icon ?? icon;
      const span = `${fmt(`${h.from}-15`, { month: "short" })}–${fmt(`${h.to}-15`, { month: "short" })}`;
      text = h.after < 20 && h.before > 200
        ? <><b>{name(h.category)} has almost stopped</b>: about {euroRound(h.after)} a month in {span}, down from {euroRound(h.before)}.</>
        : <><b>{name(h.category)} is {h.after > h.before ? "up" : "down"}</b> to about {euroRound(h.after)} a month in {span}, from {euroRound(h.before)} in the three months before.</>;
      break;
    }
    case "heavy_months":
      text = <><b>{h.months.length} of {h.of} months</b> came in well over a usual month: {h.months.map((m) => fmt(`${m}-15`, { month: "short" })).join(", ")}.</>;
      break;
  }
  return <div className="sp-hl"><span className="ricon"><Icon icon={icon} /></span><p>{text}</p></div>;
}

/** Claude's read of the period: a button until asked, then its answer in the same card. */
function Explain({ v, onDone }: { v: SpendView; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [read, setRead] = useState<Explanation | null>(v.explanation);
  useEffect(() => { setRead(v.explanation); setError(null); }, [v.range, v.off, v.explanation]);
  const label = RANGE[v.range].explain;
  const ask = () => {
    setBusy(true); setError(null);
    explainPeriod(v.range, v.off).then((r) => { setRead(r); onDone(); }).catch(setError).finally(() => setBusy(false));
  };
  if (busy) return <div className="sp-ai"><div className="sp-ai-h"><Icon icon="mdi:creation-outline" />The assistant is reading {label}…</div><div className="sp-skel" /><div className="sp-skel short" /></div>;
  if (!read) return (
    <>
      <button className="sp-ai-btn" onClick={ask}><Icon icon="mdi:creation-outline" />Explain {label}</button>
      {error != null && <ErrorNote error={error} />}
    </>
  );
  return (
    <div className="sp-ai">
      <div className="sp-ai-h"><Icon icon="mdi:creation-outline" />{read.headline}</div>
      {read.points.map((p) => <p key={p}>{p}</p>)}
      <div className="sp-try"><span>Try</span>{read.try}</div>
      <div className="sp-ai-foot"><span>From the assistant, reading {label}'s payments</span><button onClick={ask}>Again</button></div>
    </div>
  );
}

/* ---------- categories and payments ---------- */

function Categories({ v, byId }: { v: SpendView; byId: ScreenProps["byId"] }) {
  const [all, setAll] = useState(false);
  const cats = v.categories ?? [];
  const shown = all ? cats : cats.slice(0, 6);
  const year = v.range === "year";
  return (
    <>
      <Card className="list">
        <p className="small muted" style={{ margin: "10px 0 2px" }}>{year ? "The year so far, and what that is in a month" : `Compared with a usual ${v.range}${v.partial ? " by this point" : ""}`}</p>
        {shown.length === 0 && <div className="empty">Nothing spent.</div>}
        {shown.map((c) => {
          const diff = c.spent - (c.usual ?? 0);
          return (
            <a key={c.category} className="part" href={hrefFor({ page: "category", category: c.category, range: v.range, off: v.off })}>
              <span className="ricon"><Icon icon={byId[c.category]?.icon ?? "mdi:dots-horizontal"} /></span>
              <span className="t"><b>{byId[c.category]?.label ?? c.category}</b>
                <span className="muted small num">{year ? `${Math.round((c.spent / (v.total || 1)) * 100)}% of the year · ` : ""}{c.count} {c.count === 1 ? "payment" : "payments"}</span></span>
              <span className="amt num">{euroRound(c.spent)}
                <span className="sp-sub">{year ? `${euroRound(c.per_month)} a month` : Math.abs(diff) < 1 ? "as usual"
                  : <span className={diff > 0 ? "over-txt" : "ok-txt"}>{diff > 0 ? "+" : "−"}{euroRound(Math.abs(diff))}</span>}</span>
              </span>
              <Icon icon="mdi:chevron-right" />
            </a>
          );
        })}
        {cats.length > 6 && <button className="part add-row" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${cats.length}`}</button>}
      </Card>
      <Card className="list">
        <a className="part" href={hrefFor({ page: "subscriptions" })}>
          <span className="ricon"><Icon icon="mdi:repeat" /></span>
          <span className="t"><b>What you pay every month</b><span className="muted small">Subscriptions and fixed costs</span></span>
          <Icon icon="mdi:chevron-right" />
        </a>
      </Card>
    </>
  );
}

function PaymentRows({ rows, byId, withDate }: { rows: SpendPayment[]; byId: ScreenProps["byId"]; withDate?: boolean }) {
  return (
    <>
      {rows.map((p, i) => (
        <div key={`${p.date}-${p.name}-${i}`} className="part">
          <span className="ricon"><Icon icon={byId[p.category]?.icon ?? "mdi:dots-horizontal"} /></span>
          <span className="t"><b>{p.name}</b><span className="muted small">{byId[p.category]?.label ?? p.category}{withDate ? ` · ${fmt(p.date, SHORT)}` : ""}</span></span>
          <span className="amt num">{euro(p.amount)}</span>
        </div>
      ))}
    </>
  );
}

function PaymentDays({ rows, byId }: { rows: SpendPayment[]; byId: ScreenProps["byId"] }) {
  const days = new Map<string, SpendPayment[]>();
  rows.forEach((p) => days.set(p.date, [...(days.get(p.date) ?? []), p]));
  return (
    <>
      {[...days].map(([date, list]) => (
        <div key={date}>
          <div className="sp-dayh"><span>{fmt(date, { weekday: "short", day: "numeric", month: "short" })}</span>
            <span className="num">{euroRound(list.reduce((s, p) => s + p.amount, 0))}</span></div>
          <Card className="list"><PaymentRows rows={[...list].sort((a, b) => b.amount - a.amount)} byId={byId} /></Card>
        </div>
      ))}
    </>
  );
}

import { useState, type ReactNode } from "react";
import {
  addGoal, addHabit, addWish, decideWish, deleteGoal, deleteHabit, patchGoal, patchHabit, savePlan, setSavingsAccounts, useApi,
  type Category, type Goal, type GoalsOverview, type HabitDetail, type HabitsWeek, type HabitStatus, type HabitType, type Habits, type PlanView, type Wish,
} from "../lib/api";
import { euroRound, parseAmount } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { MoneyField, withPlan } from "./Settings";
import { Card, CardHeader, Crumbs, Icon, Select } from "./ui";

const at = (d: string) => new Date(`${d}T12:00:00`);
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const LONG = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { weekday: "short" });
const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.round((a / b) * 100)) : 0);

/** What each habit type counts, and the categories it can count. */
const TYPES: { type: HabitType; icon: string; title: string; shape: string; example: string; unit: string; cats?: string[] }[] = [
  { type: "fewer", icon: "mdi:repeat", title: "Fewer times", shape: "Something you do, a number of times a week or less.", example: "e.g. 5 or fewer deliveries", unit: "times a week" },
  { type: "spend_less", icon: "mdi:cash-multiple", title: "Spend less on", shape: "A category, under an amount a week.", example: "e.g. under €50 eating out", unit: "€ a week" },
  { type: "nospend", icon: "mdi:calendar-remove-outline", title: "No-spend days", shape: "Days in the week with no spending at all.", example: "e.g. 3 days a week", unit: "days a week" },
  { type: "wait", icon: "mdi:clock-outline", title: "Wait first", shape: "Buys over an amount wait 48 hours on your wishlist.", example: "e.g. anything over €50", unit: "€ or more", cats: ["shopping"] },
];
const typeOf = (t: HabitType) => TYPES.find((x) => x.type === t)!;
const STATUS: Record<HabitStatus, { label: string; cls: string }> = {
  on_track: { label: "on track", cls: "gl-ok" }, kept: { label: "kept", cls: "gl-ok" },
  at_risk: { label: "at risk", cls: "gl-warn" }, missed: { label: "missed", cls: "gl-bad" },
};

/** Goals: what you save and buy (Goals), and small weekly rules (Habits). */
export function Goals({ byId, version, section, id, onChanged }: ScreenProps & { section?: string; id?: number; onChanged: () => void }) {
  if (section === "habit" && id) return <HabitScreen id={id} byId={byId} version={version} onChanged={onChanged} />;
  if (section === "goal" && id) return <GoalScreen id={id} version={version} onChanged={onChanged} />;
  if (section === "save") return <SaveScreen version={version} onChanged={onChanged} />;
  if (section === "wishlist") return <WishlistScreen version={version} onChanged={onChanged} />;
  return section === "habits" ? <HabitsTab byId={byId} version={version} onChanged={onChanged} /> : <GoalsTab version={version} onChanged={onChanged} />;
}

function Tabs({ on, subtitle }: { on: "goals" | "habits"; subtitle: string }) {
  return (
    <>
      <header className="hello"><h1>Goals</h1><p>{subtitle}</p></header>
      <div className="seg2" role="tablist" aria-label="Show">
        <a role="tab" href={hrefFor({ page: "goals" })} aria-current={on === "goals" ? "page" : undefined}>Goals</a>
        <a role="tab" href={hrefFor({ page: "goals", section: "habits" })} aria-current={on === "habits" ? "page" : undefined}>Habits</a>
      </div>
    </>
  );
}

function Row({ icon, title, sub, amt, amtSub, amtCls, bar, barCls, href }: {
  icon: string; title: string; sub?: ReactNode; amt?: string; amtSub?: string; amtCls?: string; bar?: number; barCls?: string; href?: string;
}) {
  const body = (
    <>
      <span className="ricon"><Icon icon={icon} /></span>
      <span className="t">
        <b>{title}</b>
        {sub && <span className="muted small num">{sub}</span>}
        {bar != null && <span className="bar"><i className={barCls} style={{ width: `${bar}%` }} /></span>}
      </span>
      {amt && <span className="amt num">{amt}{amtSub && <span className={amtCls}>{amtSub}</span>}</span>}
      {href && <Icon icon="mdi:chevron-right" />}
    </>
  );
  return href ? <a className="part" href={href}>{body}</a> : <div className="part">{body}</div>;
}

// ---------- Goals ----------

function GoalsTab({ version, onChanged }: { version: number; onChanged: () => void }) {
  const { data, error, reload } = useApi<GoalsOverview>("/api/goals/overview", version);
  const habits = useApi<Habits>("/api/habits", version);
  const [sheet, setSheet] = useState(false);
  const done = () => { reload(); onChanged(); };
  const saves = data?.goals.filter((g) => g.kind === "save") ?? [];
  const buys = data?.goals.filter((g) => g.kind !== "save") ?? [];
  const s = data?.save_monthly;
  const wishes = habits.data?.wishlist.length ?? 0;
  return (
    <>
      <Tabs on="goals" subtitle={data ? `${euroRound(data.monthly)} a month goes to your goals` : "What you're saving for"} />
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <div className="col">
          <div className="group-label">Save</div>
          <Card className="list">
            {s && s.target != null ? (
              <Row icon="mdi:piggy-bank-outline" title="Save every month" sub="Into your savings" href={hrefFor({ page: "goals", section: "save" })}
                amt={euroRound(s.target)} amtSub={s.saved >= s.target ? "done this month" : `${euroRound(Math.max(0, s.saved))} so far`}
                amtCls={s.saved >= s.target ? "gl-ok" : undefined} bar={pct(s.saved, s.target)} />
            ) : (
              <Row icon="mdi:piggy-bank-outline" title="Save every month" sub="Set your income first" href={hrefFor({ page: "settings", section: "income" })} />
            )}
            {saves.map((g) => <GoalRow key={g.id} g={g} />)}
          </Card>
          <div className="group-label">Buy</div>
          <Card className="list">
            {buys.map((g) => <GoalRow key={g.id} g={g} />)}
            <Row icon="mdi:clock-outline" title="Wishlist" href={hrefFor({ page: "goals", section: "wishlist" })}
              sub={wishes ? `${wishes} ${wishes === 1 ? "thing" : "things"} waiting out 48 hours` : "Wait 48 hours before you buy"} />
          </Card>
          {data.suggestion && (
            <Card className="list suggest">
              <div className="card-h gl-sug-h"><h2><Icon icon="mdi:creation-outline" />Suggested for you</h2></div>
              <div className="part">
                <span className="ricon"><Icon icon="mdi:shield-check-outline" /></span>
                <span className="t"><span className="muted small">Save</span><b>Safety net of {euroRound(data.suggestion.price)}</b>
                  <span className="muted small gl-wrap">3 months of your costs, for when something goes wrong. {euroRound(data.suggestion.monthly)} a month for a year.</span></span>
                <button className="chip" onClick={() => addGoal(data.suggestion!).then(done)}><Icon icon="mdi:plus" />Add</button>
              </div>
            </Card>
          )}
          <button className="btn ghost block" onClick={() => setSheet(true)}><Icon icon="mdi:plus" />New goal</button>
          {data.extra_pay[0] && (
            <p className="hint gl-note">Extra pay coming: {data.extra_pay[0].name}, about {euroRound(data.extra_pay[0].amount)}. {data.extra_pay[0].when}.</p>
          )}
          {data.left != null && data.take_home != null && (
            <p className={`hint gl-note ${data.left < 0 ? "gl-warn" : ""}`}>
              From your {euroRound(data.take_home)} pay, after {euroRound(data.committed)} of <a href={hrefFor({ page: "settings", section: "fixed" })}>fixed costs</a> and
              your goals, {data.left >= 0 ? `${euroRound(data.left)} is left to spend.` : `you're ${euroRound(-data.left)} short each month.`}
            </p>
          )}
        </div>
      )}
      {sheet && <NewGoalSheet onClose={() => setSheet(false)} onAdded={() => { setSheet(false); done(); }} />}
    </>
  );
}

function GoalRow({ g }: { g: Goal }) {
  return (
    <Row icon={g.kind === "save" ? "mdi:shield-check-outline" : "mdi:target"} title={g.name} href={hrefFor({ page: "goals", section: "goal", id: g.id })}
      sub={`${euroRound(g.saved)} of ${euroRound(g.price)} · by ${SHORT.format(at(g.target_date))}`}
      amt={g.remaining > 0 ? euroRound(g.monthly) : "Done"} amtSub={g.remaining > 0 ? "a month" : undefined} bar={pct(g.saved, g.price)} />
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="so-sheet-bg" onClick={onClose}>
      <div className="so-sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="so-sh">{title}<button className="chip icon-only" aria-label="Close" onClick={onClose}><Icon icon="mdi:close" /></button></div>
        {children}
      </div>
    </div>
  );
}

function NewGoalSheet({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [kind, setKind] = useState<"buy" | "save" | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [when, setWhen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (!kind) {
    return (
      <Sheet title="New goal" onClose={onClose}>
        <div className="list">
          <a className="part" href={hrefFor({ page: "goals", section: "save" })}><span className="ricon"><Icon icon="mdi:piggy-bank-outline" /></span>
            <span className="t"><b>Save every month</b><span className="muted small gl-wrap">How much goes to your savings when you're paid.</span></span><Icon icon="mdi:chevron-right" /></a>
          <button className="part" onClick={() => setKind("save")}><span className="ricon"><Icon icon="mdi:shield-check-outline" /></span>
            <span className="t"><b>Save a total</b><span className="muted small gl-wrap">An amount by a date, like a safety net.</span></span><Icon icon="mdi:chevron-right" /></button>
          <button className="part" onClick={() => setKind("buy")}><span className="ricon"><Icon icon="mdi:cart-outline" /></span>
            <span className="t"><b>Buy something</b><span className="muted small gl-wrap">A trip, a bike, a laptop. Pick a price and a date, and the app works out each month's share.</span></span><Icon icon="mdi:chevron-right" /></button>
        </div>
      </Sheet>
    );
  }
  return (
    <Sheet title={kind === "buy" ? "Buy something" : "Save a total"} onClose={onClose}>
      <form className="form" onSubmit={(e) => {
        e.preventDefault(); setError(null);
        addGoal({ name, price: parseAmount(price), target_date: when, kind }).then(onAdded).catch((err: Error) => setError(err.message));
      }}>
        <label className="fld"><span>{kind === "buy" ? "What do you want to buy?" : "What is it for?"}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "buy" ? "e.g. a new bike" : "e.g. safety net"} required /></label>
        <div className="big2">
          <label className="fld"><span>{kind === "buy" ? "Price" : "Amount"}</span>
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="€" required /></label>
          <label className="fld"><span>By when</span>
            <input className="input" type="date" min={tomorrow} value={when} onChange={(e) => setWhen(e.target.value)} required /></label>
        </div>
        <button className="btn block" type="submit" disabled={!name || !parseAmount(price) || !when}>Add goal</button>
        {error && <div className="error">{error}</div>}
      </form>
    </Sheet>
  );
}

function GoalScreen({ id, version, onChanged }: { id: number; version: number; onChanged: () => void }) {
  const { data, reload } = useApi<GoalsOverview>("/api/goals/overview", version);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const g = data?.goals.find((x) => x.id === id);
  const done = () => { reload(); onChanged(); };
  if (!data) return <div className="skeleton" />;
  if (!g) return <><Crumbs items={[{ label: "Goals", href: hrefFor({ page: "goals" }) }]} /><div className="empty">This goal is gone.</div></>;
  const add = (sign: 1 | -1) => {
    const v = parseAmount(amount);
    if (!v) return;
    setBusy(true);
    patchGoal(g.id, { add: sign * v }).then(() => { setAmount(""); done(); }).finally(() => setBusy(false));
  };
  return (
    <>
      <Crumbs items={[{ label: "Goals", href: hrefFor({ page: "goals" }) }, { label: g.name }]} />
      <header className="hello"><h1>{g.name}</h1><p>{euroRound(g.price)} by {LONG.format(at(g.target_date))}</p></header>
      <div className="col">
        <Card>
          <div className="sp-total num">{euroRound(g.saved)}<small>of {euroRound(g.price)}</small></div>
          <span className="bar gl-bar"><i style={{ width: `${pct(g.saved, g.price)}%` }} /></span>
          <div className="pace-legend num gl-legend">
            <span>{g.remaining > 0 ? `${euroRound(g.monthly)} a month, ${euroRound(g.weekly)} a week` : "All of it is there"}</span>
            <span>{g.remaining > 0 ? `${g.weeks_left} ${g.weeks_left === 1 ? "week" : "weeks"} left` : ""}</span>
          </div>
          <div className="row-actions">
            <input className="input money" inputMode="decimal" placeholder="€" value={amount} aria-label={`Amount for ${g.name}`} onChange={(e) => setAmount(e.target.value)} />
            <button className="chip" disabled={busy || !amount} onClick={() => add(1)}><Icon icon="mdi:plus" />Put aside</button>
            <button className="chip" disabled={busy || !amount} onClick={() => add(-1)}><Icon icon="mdi:minus" />Took out</button>
          </div>
        </Card>
        {g.remaining > 0 && <p className="hint gl-note">This goal takes {euroRound(g.monthly)} a month out of what you can spend, until {LONG.format(at(g.target_date))}.</p>}
        <button className="btn ghost block gl-stop" disabled={busy} onClick={() => {
          if (confirm(`Delete "${g.name}"?`)) deleteGoal(g.id).then(() => { onChanged(); location.hash = hrefFor({ page: "goals" }); });
        }}>Delete goal</button>
      </div>
    </>
  );
}

/** Saving every month: the plan's savings amount, and the accounts it goes into. Used to live in Settings. */
function SaveScreen({ version, onChanged }: { version: number; onChanged: () => void }) {
  const plan = useApi<PlanView>("/api/plan", version);
  const habits = useApi<Habits>("/api/habits", version);
  const done = () => { plan.reload(); habits.reload(); onChanged(); };
  const view = plan.data;
  const p = habits.data?.pay_first;
  const accounts = p?.accounts ?? [];
  const chosen = accounts.filter((a) => a.selected).map((a) => a.id);
  const toggle = (aid: string) => setSavingsAccounts(chosen.includes(aid) ? chosen.filter((x) => x !== aid) : [...chosen, aid]).then(done);
  return (
    <>
      <Crumbs items={[{ label: "Goals", href: hrefFor({ page: "goals" }) }, { label: "Save every month" }]} />
      <header className="hello"><h1>Save every month</h1><p>What you put aside when you get paid.</p></header>
      <div className="col">
        {!view && <div className="skeleton" />}
        {view && (view.plan ? (
          <MoneyField value={view.plan.keep} label="Savings a month" suffix="a month" onSave={(v) => savePlan(withPlan(view, { keep: v })).then(done)} />
        ) : (
          <Card><p className="hint" style={{ margin: 0 }}>Set your <a href={hrefFor({ page: "settings", section: "income" })}>monthly income</a> first.</p></Card>
        ))}
        {p && p.target != null && (
          <Card>
            <div className="label" style={{ marginTop: 0 }}>Since you were paid on {LONG.format(at(p.since))}</div>
            <div className="sp-total num">{euroRound(Math.max(0, p.saved))}<small>of {euroRound(p.target)} moved</small></div>
            <span className="bar gl-bar"><i style={{ width: `${pct(p.saved, p.target)}%` }} /></span>
            {chosen.length === 0 && <p className="hint">Pick the accounts you save into, and the app counts what reaches them.</p>}
          </Card>
        )}
        {accounts.length > 0 && (
          <>
            <div className="group-label">Saving into</div>
            <Card className="list">
              {accounts.map((a) => (
                <button key={a.id} className="part" role="checkbox" aria-checked={a.selected} onClick={() => toggle(a.id)}>
                  <span className="t"><b>{a.name}</b><span className="muted small">{a.bank}</span></span>
                  <span className={`check ${a.selected ? "on" : ""}`}>{a.selected && <Icon icon="mdi:check" />}</span>
                </button>
              ))}
            </Card>
          </>
        )}
      </div>
    </>
  );
}

function WishlistScreen({ version, onChanged }: { version: number; onChanged: () => void }) {
  const { data, reload } = useApi<Habits>("/api/habits", version);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [saveFor, setSaveFor] = useState<Wish | null>(null);
  const [when, setWhen] = useState("");
  const done = () => { reload(); onChanged(); };
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return (
    <>
      <Crumbs items={[{ label: "Goals", href: hrefFor({ page: "goals" }) }, { label: "Wishlist" }]} />
      <header className="hello"><h1>Wishlist</h1><p>Want something that isn't essential? Wait two days first. You'll get a reminder.</p></header>
      <div className="col">
        <Card>
          <form className="field" style={{ marginTop: 0 }} onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && parseAmount(price)) addWish(name, parseAmount(price)).then(() => { setName(""); setPrice(""); done(); });
          }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. running shoes" aria-label="What you want" />
            <input className="input money" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="€" aria-label="Price" />
            <button className="chip" type="submit" disabled={!name.trim() || !parseAmount(price)}><Icon icon="mdi:plus" />Add</button>
          </form>
        </Card>
        {data && data.wishlist.length > 0 && (
          <Card className="list">
            {data.wishlist.map((w) => (
              <div key={w.id}>
                <div className="part">
                  <span className="ricon"><Icon icon="mdi:shopping-outline" /></span>
                  <span className="t"><b>{w.name}</b>
                    <span className="muted small">{w.ready ? "Two days are up" : `Ask again ${new Date(w.ready_at).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" })}`}</span></span>
                  <span className="amt num">{euroRound(w.price)}{w.hours_of_work ? <span>{w.hours_of_work.toFixed(0)} h of work</span> : null}</span>
                </div>
                {w.ready && (
                  <div className="row-actions" style={{ marginTop: 0, marginBottom: 8 }}>
                    <button className="chip" onClick={() => decideWish(w.id, "skipped").then(done)}>Skip it</button>
                    <button className="chip" onClick={() => setSaveFor(w)}>Save up for it</button>
                    <button className="chip" onClick={() => decideWish(w.id, "bought").then(done)}>Bought it</button>
                  </div>
                )}
                {saveFor?.id === w.id && (
                  <form className="field" style={{ marginBottom: 10 }} onSubmit={(e) => {
                    e.preventDefault();
                    addGoal({ name: w.name, price: w.price, target_date: when }).then(() => decideWish(w.id, "goal")).then(() => { setSaveFor(null); done(); });
                  }}>
                    <input className="input" type="date" min={tomorrow} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="By when" required />
                    <button className="chip" type="submit" disabled={!when}>Make it a goal</button>
                  </form>
                )}
              </div>
            ))}
          </Card>
        )}
        {data && data.skipped_year > 0 && <p className="hint gl-note num">Skipped after waiting this year: {euroRound(data.skipped_year)}.</p>}
      </div>
    </>
  );
}

// ---------- Habits ----------

function HabitsTab({ byId, version, onChanged }: { byId: Record<string, Category>; version: number; onChanged: () => void }) {
  const { data, error, reload } = useApi<HabitsWeek>("/api/habits/weekly", version);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = () => { reload(); onChanged(); };
  const range = data ? `${at(data.week.start).getDate()} – ${SHORT.format(at(data.week.end))}` : "";
  return (
    <>
      <Tabs on="habits" subtitle="Small rules, checked every week" />
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <div className="col">
          {data.total > 0 && (
            <Card>
              <div className="label" style={{ marginTop: 0 }}>This week · {range}</div>
              <div className="sp-total num">{data.on_track}<small>of {data.total} on track</small></div>
              {data.nudge ? (
                <div className="status warn"><Icon icon="mdi:alert-circle-outline" /><div><b>{data.nudge.title}</b><p>{data.nudge.text}</p></div></div>
              ) : (
                <div className="status"><Icon icon="mdi:check-circle-outline" /><div><b>All on track</b><p>{data.week.days_left === 1 ? "Today is the last day of the week." : `${data.week.days_left} days left this week.`}</p></div></div>
              )}
              {data.saved > 0 && <p className="hint">Your habits have saved you about {euroRound(data.saved)} so far.</p>}
            </Card>
          )}
          {data.total > 0 && <div className="group-label">Your habits</div>}
          {data.total > 0 && (
            <Card className="list">
              {data.habits.map((h) => {
                const st = STATUS[h.status];
                const money = h.type === "spend_less";
                return (
                  <Row key={h.id} icon={iconFor(h.type, h.category, byId)} title={h.title} href={hrefFor({ page: "goals", section: "habit", id: h.id })}
                    sub={h.streak ? `${h.streak} ${h.streak === 1 ? "week" : "weeks"} in a row` : typeOf(h.type).title}
                    amt={h.type === "wait" ? (h.value ? `${h.value} skipped` : "None") : money ? `${euroRound(h.value)} of ${euroRound(h.target)}` : `${h.value} of ${h.target}`}
                    amtSub={st.label} amtCls={st.cls} bar={h.type === "wait" ? undefined : pct(h.value, h.target)}
                    barCls={h.status === "at_risk" || h.status === "missed" ? "ahead" : undefined} />
                );
              })}
            </Card>
          )}
          {data.total === 0 && (
            <Card><p className="hint" style={{ margin: 0 }}>A habit is one small rule for the week, like fewer deliveries or a few days without spending. The app counts it from your payments and tells you how the week is going.</p></Card>
          )}
          {data.suggestions.length > 0 && (
            <Card className="list suggest">
              <div className="card-h gl-sug-h"><h2><Icon icon="mdi:creation-outline" />Suggested from your spending</h2></div>
              {data.suggestions.map((s) => (
                <div key={s.title} className="part">
                  <span className="ricon"><Icon icon={iconFor(s.type, s.category, byId)} /></span>
                  <span className="t"><span className="muted small">{typeOf(s.type).title}</span><b className="gl-wrap">{s.title}</b>
                    <span className="muted small gl-wrap">{s.why}{s.monthly ? ` Saves about ${euroRound(s.monthly)} a month.` : ""}</span></span>
                  <button className="chip" disabled={busy} onClick={() => { setBusy(true); addHabit(s).then(done).finally(() => setBusy(false)); }}><Icon icon="mdi:plus" />Add</button>
                </div>
              ))}
            </Card>
          )}
          <button className="btn ghost block" onClick={() => setSheet(true)}><Icon icon="mdi:plus" />New habit</button>
        </div>
      )}
      {sheet && <NewHabitSheet byId={byId} onClose={() => setSheet(false)} onAdded={() => { setSheet(false); done(); }} />}
    </>
  );
}

function iconFor(t: HabitType, category: string | null, byId: Record<string, Category>) {
  if (t === "nospend") return "mdi:calendar-remove-outline";
  return (category && byId[category]?.icon) || typeOf(t).icon;
}

function NewHabitSheet({ byId, onClose, onAdded }: { byId: Record<string, Category>; onClose: () => void; onAdded: () => void }) {
  const [type, setType] = useState<HabitType | null>(null);
  const [category, setCategory] = useState("delivery");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cats = Object.values(byId).filter((c) => c.spending);
  if (!type) {
    return (
      <Sheet title="New habit" onClose={onClose}>
        <div className="list">
          {TYPES.map((t) => (
            <button key={t.type} className="part" onClick={() => { setType(t.type); setCategory(t.cats?.[0] ?? "delivery"); }}>
              <span className="ricon"><Icon icon={t.icon} /></span>
              <span className="t"><b>{t.title}</b><span className="muted small gl-wrap">{t.shape}</span><span className="small">{t.example}</span></span>
              <Icon icon="mdi:chevron-right" />
            </button>
          ))}
        </div>
      </Sheet>
    );
  }
  const t = typeOf(type);
  return (
    <Sheet title={t.title} onClose={onClose}>
      <form className="form" onSubmit={(e) => {
        e.preventDefault(); setError(null);
        addHabit({ type, category: type === "nospend" ? null : category, target: parseAmount(target) }).then(onAdded).catch((err: Error) => setError(err.message));
      }}>
        <p className="hint" style={{ marginTop: 0 }}>{t.shape}</p>
        {type !== "nospend" && (
          <label className="fld"><span>{type === "wait" ? "Buys in" : "What it counts"}</span>
            <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select></label>
        )}
        <label className="fld"><span>{type === "nospend" ? "Days a week" : type === "fewer" ? "Times a week, at most" : type === "spend_less" ? "Euros a week, at most" : "Over this amount"}</span>
          <input className="input" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={type === "fewer" ? "5" : type === "nospend" ? "3" : "€50"} required /></label>
        <button className="btn block" type="submit" disabled={!parseAmount(target)}>Add habit</button>
        {error && <div className="error">{error}</div>}
      </form>
    </Sheet>
  );
}

function HabitScreen({ id, byId, version, onChanged }: { id: number; byId: Record<string, Category>; version: number; onChanged: () => void }) {
  const { data: h, error, reload } = useApi<HabitDetail>(`/api/habits/rules/${id}`, version);
  const goals = useApi<GoalsOverview>("/api/goals/overview", version);
  const done = () => { reload(); onChanged(); };
  const crumbs = [{ label: "Habits", href: hrefFor({ page: "goals", section: "habits" }) }, { label: h?.title ?? "Habit" }];
  if (error) return <><Crumbs items={crumbs} /><div className="empty">This habit is gone.</div></>;
  if (!h) return <div className="skeleton" />;
  const t = typeOf(h.type);
  const money = h.type === "spend_less";
  const shown = (v: number) => (money ? euroRound(v) : String(v));
  const top = Math.max(h.target, ...h.weeks.map((w) => w.value), 1) * 1.15;
  const todayIso = new Date().toLocaleDateString("en-CA");
  const st = STATUS[h.status];
  return (
    <>
      <Crumbs items={crumbs} />
      <header className="hello"><h1>{h.title}</h1><p>{t.title} · counted Monday to Sunday</p></header>
      <div className="col">
        <Card>
          <div className="label" style={{ marginTop: 0 }}>This week · <span className={st.cls}>{st.label}</span></div>
          <div className="sp-total num">{shown(h.value)}<small>{h.type === "nospend" ? `of ${h.target} days` : h.type === "wait" ? "skipped the wishlist" : `of ${shown(h.target)}`}</small></div>
          {h.type !== "wait" && (
            <div className="gl-week">
              {h.days.map((d) => {
                const isToday = d.date === todayIso;
                const good = h.type === "nospend" ? d.value === 1 : d.value === 0;
                return (
                  <div key={d.date}>
                    <b className={[d.value === null && !isToday ? "later" : good ? "zero" : "", isToday ? "today" : ""].join(" ")}>
                      {d.value === null ? "" : h.type === "nospend" ? <Icon icon={d.value ? "mdi:check" : "mdi:close"} /> : money ? Math.round(d.value) : d.value}
                    </b>
                    <span className={isToday ? "now" : ""}>{WEEKDAY.format(at(d.date))}</span>
                  </div>
                );
              })}
            </div>
          )}
          <p className="hint">{h.nudge}</p>
        </Card>
        <Card>
          <CardHeader icon={iconFor(h.type, h.category, byId)} title={h.type === "nospend" ? "No-spend days a week" : h.type === "wait" ? "Skipped the wishlist, a week" : money ? "Spent a week" : "Times a week"} />
          <div className="sp-bars" style={{ gridTemplateColumns: `repeat(${h.weeks.length}, 1fr)`, height: 80 }}>
            {h.weeks.map((w) => (
              <i key={w.start} className={w.current ? "cur" : w.status === "missed" && w.counted ? "hot" : ""} style={{ height: `${Math.max(2, (w.value / top) * 100)}%` }}
                title={`${SHORT.format(at(w.start))}: ${shown(w.value)}`} />
            ))}
            {h.type !== "wait" && <span className="sp-ref" style={{ bottom: `${(h.target / top) * 100}%` }}><em className="num">{h.type === "nospend" ? "aim" : "limit"} {shown(h.target)}</em></span>}
          </div>
          <div className="sp-x" style={{ gridTemplateColumns: `repeat(${h.weeks.length}, 1fr)` }}>
            {h.weeks.map((w, i) => <span key={w.start}>{w.current ? "Now" : i % 2 === 0 ? SHORT.format(at(w.start)) : ""}</span>)}
          </div>
          <div className="big2 gl-stats">
            <div><span className="muted small">In a row</span><b className="num">{h.streak} {h.streak === 1 ? "week" : "weeks"}</b></div>
            <div><span className="muted small">Saved so far</span><b className="num">{h.type === "fewer" || money ? euroRound(h.saved) : "–"}</b></div>
          </div>
        </Card>
        <Card className="list">
          <div className="part"><span className="t"><b>{h.type === "wait" ? "Over" : "Aim"}</b><span className="muted small">{t.unit}</span></span>
            <TargetField value={h.target} onSave={(v) => patchHabit(h.id, { target: v }).then(done)} /></div>
          <div className="part"><span className="t"><b>Goes towards</b><span className="muted small">What it saves is for</span></span>
            <Select variant="sm" aria-label="Goes towards" value={h.goal_id ?? ""} onChange={(e) => {
              const v = e.target.value;
              (v ? patchHabit(h.id, { goal_id: Number(v) }) : patchHabit(h.id, { clear_goal: true })).then(done);
            }}>
              <option value="">Nothing yet</option>
              {goals.data?.goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select></div>
        </Card>
        <button className="btn ghost block gl-stop" onClick={() => {
          if (confirm(`Stop "${h.title}"?`)) deleteHabit(h.id).then(() => { onChanged(); location.hash = hrefFor({ page: "goals", section: "habits" }); });
        }}>Stop this habit</button>
      </div>
    </>
  );
}

function TargetField({ value, onSave }: { value: number; onSave: (v: number) => Promise<unknown> }) {
  const [text, setText] = useState(String(value));
  return (
    <input className="input money" inputMode="decimal" aria-label="Aim" value={text} onChange={(e) => setText(e.target.value)}
      onBlur={() => { const v = parseAmount(text); if (v > 0 && v !== value) onSave(v); else setText(String(value)); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
  );
}


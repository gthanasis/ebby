import { useEffect, useState, type ReactNode } from "react";
import {
  addCommitment, deleteCommitment, editCommitment, savePlan, saveSettings, useApi,
  type AssistantModel, type Commitment, type Commitments, type Me, type Payday, type Plan, type PlanView, type Status,
} from "../lib/api";
import { AccountCard, AiScreen, aiValue, BankAccessScreen, NamesScreen, PeopleScreen, SubPage } from "./Account";
import { useAction } from "../lib/action";
import { euroRound, ordinal, parseAmount } from "../lib/format";
import { currentSubscription, disablePush, enablePush, pushSupport } from "../lib/push";
import { hrefFor, type ScreenProps } from "./App";
import { Card, Icon, Select } from "./ui";

// "savings" isn't one: it moved to Goals, and SettingsScreen sends old links there.
type Section = "income" | "payday" | "fixed" | "budgets" | "assistant" | "bank-access" | "ai" | "names" | "people";

/** What a section's screen can draw from. */
interface SectionProps {
  view: PlanView; commitments?: Commitments; commitment?: number; byId: ScreenProps["byId"]; me?: Me;
  changed: () => void; meChanged: () => void;
}

/** Each section's screen. `needsMe`: only with a signed-in person; on a server without /api/me the link shows the list. */
const SECTIONS: Record<Section, { needsMe?: boolean; render(p: SectionProps): ReactNode }> = {
  income: { render: ({ view, changed }) => <IncomeScreen view={view} onChanged={changed} /> },
  payday: { render: ({ view, changed }) => <PaydayScreen view={view} onChanged={changed} /> },
  fixed: {
    render: ({ commitments, commitment, changed }) => commitment != null
      ? <FixedCostScreen id={commitment} commitments={commitments} onChanged={changed} />
      : <FixedScreen commitments={commitments} onChanged={changed} />,
  },
  budgets: { render: ({ view, byId, changed }) => <BudgetsScreen view={view} onChanged={changed} byId={byId} /> },
  assistant: { render: ({ view, changed }) => <AssistantModelScreen view={view} onChanged={changed} /> },
  names: { render: ({ view, changed }) => <NamesScreen names={view.settings.owner_names ?? []} onChanged={changed} /> },
  "bank-access": { needsMe: true, render: ({ me, meChanged }) => <BankAccessScreen me={me!} onChanged={meChanged} /> },
  ai: { needsMe: true, render: ({ me, meChanged }) => <AiScreen me={me!} onChanged={meChanged} /> },
  people: { needsMe: true, render: ({ me }) => <PeopleScreen me={me!} /> },
};

const BANK_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Plain settings: one row per setting, each opening a screen that asks one thing. */
export function SettingsScreen({ byId, version, section, commitment, status, me, reloadMe, onChanged }: ScreenProps & {
  section?: string; commitment?: number; status?: Status; reloadStatus: () => void; onChanged: () => void;
  /** The signed-in person; missing on a server without /api/me. */
  me?: Me; reloadMe: () => void;
}) {
  const plan = useApi<PlanView>("/api/plan", version);
  const commitments = useApi<Commitments>("/api/commitments", version);
  const changed = () => { plan.reload(); commitments.reload(); onChanged(); };
  // Savings moved to Goals; old links still land there.
  useEffect(() => { if (section === "savings") location.replace(hrefFor({ page: "goals", section: "save" })); }, [section]);
  const view = plan.data;

  if (plan.error) return <div className="error">{plan.error}</div>;
  if (!view) return <div className="skeleton" />;
  const screen = section && Object.hasOwn(SECTIONS, section) ? SECTIONS[section as Section] : undefined;
  if (screen && (!screen.needsMe || me)) {
    return screen.render({ view, commitments: commitments.data, commitment, byId, me, changed, meChanged: () => { reloadMe(); changed(); } });
  }

  const p = view.plan;
  const s = view.settings;
  return (
    <>
      <header className="hello"><h1>Settings</h1></header>
      <div className="col">
      {me && <AccountCard me={me} />}
      {s.autofilled && !s.autofill_dismissed && (
        <div className="banner">
          <Icon icon="mdi:creation-outline" />
          <div>
            <b>We filled these in for you</b>
            <p>From your transactions so far. Change anything that doesn't look right.</p>
            <button className="chip" onClick={() => saveSettings({ autofill_dismissed: true }).then(changed)}>Got it</button>
          </div>
        </div>
      )}
      <div className="group-label">Budget</div>
      <Card className="list">
        <Row icon="mdi:cash-multiple" title="Monthly income" value={p ? `${euroRound(p.take_home)}${s.extra_pay ? " · 14 salaries" : ""}` : "Not set"} section="income" />
        <Row icon="mdi:calendar-month-outline" title="Payday" value={paydayLabel(s.payday ?? 1)} section="payday" />
        <Row icon="mdi:repeat" title="Fixed costs" value={`${euroRound(view.committed)} a month`} section="fixed" />
        <Row icon="mdi:chart-pie" title="Category budgets" value={p ? (p.split === "auto" ? "Automatic" : "Custom") : "Not set"} section="budgets" />
      </Card>
      {(view.ai || me) && (
        <>
          <div className="group-label">Assistant</div>
          <Card className="list">
            {me && <Row icon="mdi:creation-outline" title="AI" value={aiValue(me)} section="ai" />}
            {view.ai && <Row icon="mdi:tune-variant" title="Model" value={MODELS[s.assistant_model ?? "haiku"].label} section="assistant" />}
          </Card>
        </>
      )}
      <div className="group-label">Notifications</div>
      <Notifications view={view} onChanged={changed} />
      <div className="group-label">Banks</div>
      <Banks status={status} />
      <Card className="list">
        {me && <Row icon="mdi:key-outline" title="Bank access" value={me.credentials?.enable_banking ? "Enable Banking" : "Not set up"} section="bank-access" />}
        <Row icon="mdi:account-outline" title="Your names" value={namesValue(s.owner_names)} section="names" />
      </Card>
      {me?.is_admin && (
        <>
          <div className="group-label">Admin</div>
          <Card className="list">
            <Row icon="mdi:account-group-outline" title="People" value="Invite, allowances" section="people" />
          </Card>
        </>
      )}
      </div>
    </>
  );
}

function Row({ icon, title, value, section }: { icon: string; title: string; value: string; section: Section }) {
  return (
    <a className="part" href={hrefFor({ page: "settings", section })}>
      <span className="ricon"><Icon icon={icon} /></span>
      <span className="t"><b>{title}</b></span>
      <span className="val num">{value}</span>
      <Icon icon="mdi:chevron-right" />
    </a>
  );
}

const MODELS: Record<AssistantModel, { label: string; note: string }> = {
  haiku: { label: "Haiku", note: "Fastest and cheapest. Well under a cent a question." },
  sonnet: { label: "Sonnet", note: "More careful with tricky questions. About 20 times Haiku's price." },
  opus: { label: "Opus", note: "The most capable. About 40 times Haiku's price." },
};

function AssistantModelScreen({ view, onChanged }: { view: PlanView; onChanged: () => void }) {
  const current = view.settings.assistant_model ?? "haiku";
  const pick = (m: AssistantModel) => { if (m !== current) saveSettings({ assistant_model: m }).then(onChanged); };
  return (
    <SubPage title="Assistant model" help="Answers your questions in the Assistant tab and guesses categories when you sort payments.">
      <Card className="list"><div role="radiogroup" aria-label="Assistant model">
        {(Object.keys(MODELS) as AssistantModel[]).map((m) => (
          <div key={m} className="part opt" role="radio" aria-checked={m === current} tabIndex={0} onClick={() => pick(m)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(m); } }}>
            <span className={`radio ${m === current ? "on" : ""}`} />
            <span className="t"><b>{MODELS[m].label}</b><span className="muted small text-wrap">{MODELS[m].note}</span></span>
          </div>
        ))}
      </div></Card>
    </SubPage>
  );
}

const namesValue = (names?: string[]) => !names?.length ? "Not set" : names.length === 1 ? "1 spelling" : `${names.length} spellings`;
const paydayLabel = (d: Payday) => d === "last" ? "Last working day" : d === 1 ? "1st of the month" : `The ${ordinal(d)}`;

/** A euro amount that saves when you leave the field or press Enter. */
export function MoneyField({ value, label, suffix, onSave }: { value: number; label: string; suffix: string; onSave: (v: number) => Promise<unknown> }) {
  const shown = (v: number) => (v ? Math.round(v).toLocaleString("en-GB") : "");
  const [text, setText] = useState(shown(value));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setText(shown(value)); }, [value]);
  const save = () => {
    const v = parseAmount(text);
    if (v === Math.round(value)) return;
    setError(null);
    onSave(v).then(() => { setSaved(true); setTimeout(() => setSaved(false), 1500); }).catch((e: Error) => setError(e.message));
  };
  return (
    <div>
      <label className="money-field">
        <span>€</span>
        <input className="num" inputMode="numeric" aria-label={label} value={text} placeholder="0"
          onChange={(e) => setText(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        <em>{saved ? "Saved" : suffix}</em>
      </label>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** The plan with one thing changed. A plan that doesn't exist yet starts with nothing kept and an automatic split. */
export function withPlan(view: PlanView, change: Partial<Plan>): Plan {
  const p = view.plan;
  return { take_home: p?.take_home ?? 0, keep: p?.keep ?? 0, budgets: p?.budgets ?? {}, split: p?.split ?? "auto", ...change };
}

function IncomeScreen({ view, onChanged }: { view: PlanView; onChanged: () => void }) {
  const on = !!view.settings.extra_pay;
  const [busy, setBusy] = useState(false);
  const toggle = () => { setBusy(true); saveSettings({ extra_pay: !on }).then(onChanged).finally(() => setBusy(false)); };
  return (
    <SubPage title="Monthly income" help="What reaches your account each month, after tax.">
      <MoneyField value={view.plan?.take_home ?? 0} label="Monthly income" suffix="a month"
        onSave={(v) => savePlan(withPlan(view, { take_home: v })).then(onChanged)} />
      <Card className="list">
        <div className="part">
          <span className="ricon"><Icon icon="mdi:gift-outline" /></span>
          <span className="t"><b>14 salaries a year</b><span className="muted small">Easter, summer and Christmas bonuses</span></span>
          <button className="switch" role="switch" aria-checked={on} aria-label="14 salaries a year" disabled={busy} onClick={toggle}><i /></button>
        </div>
      </Card>
      {on && view.extra_pay.length > 0 && (
        <>
          <div className="group-label">Coming up</div>
          <Card className="list">
            {view.extra_pay.map((b) => (
              <div key={b.date} className="part">
                <span className="t"><b>{b.name}</b><span className="muted small">{b.when}</span></span>
                <span className="amt num">about {euroRound(b.amount)}</span>
              </div>
            ))}
          </Card>
          <p className="hint" style={{ margin: "0 4px" }}>Your monthly budget stays on your normal pay; the bonuses are extra. A month's pay at Christmas and half at Easter and in summer, so the amounts are rough.</p>
        </>
      )}
    </SubPage>
  );
}

function PaydayScreen({ view, onChanged }: { view: PlanView; onChanged: () => void }) {
  const day = view.settings.payday ?? 1;
  const specific = day !== 1 && day !== "last";
  const set = (d: Payday) => saveSettings({ payday: d }).then(onChanged);
  const guess = view.payday_detected?.day;
  const option = (on: boolean, label: string, pick: () => void, extra?: ReactNode) => (
    <div className="part opt" role="radio" aria-checked={on} tabIndex={0} onClick={pick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }}>
      <span className={`radio ${on ? "on" : ""}`} />
      <span className="t"><b>{label}</b></span>
      {extra}
    </div>
  );
  return (
    <SubPage title="Payday" help="Your budget month starts the day you get paid. Pay that lands on a weekend counts from the Friday before.">
      <Card className="list"><div role="radiogroup" aria-label="Payday">
        {option(day === 1, "1st of the month", () => set(1))}
        {option(day === "last", "Last working day", () => set("last"))}
        {option(specific, "A specific day", () => { if (!specific) set(guess && guess > 1 && guess <= 28 ? guess : 15); },
          specific && (
            <span onClick={(e) => e.stopPropagation()}>
              <Select variant="sm" aria-label="Day of the month" value={day} onChange={(e) => set(Number(e.target.value))}>
                {Array.from({ length: 27 }, (_, i) => i + 2).map((d) => <option key={d} value={d}>the {ordinal(d)}</option>)}
              </Select>
            </span>
          ))}
      </div></Card>
    </SubPage>
  );
}


const OFTEN: { months: number; label: string; every: string }[] = [
  { months: 1, label: "Monthly", every: "Every month" }, { months: 3, label: "3 months", every: "Every 3 months" },
  { months: 6, label: "6 months", every: "Every 6 months" }, { months: 12, label: "Yearly", every: "Every year" },
];
const everyLabel = (m: number) => OFTEN.find((o) => o.months === m)?.every ?? `Every ${m} months`;
const DAY_LONG = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const dayLong = (d: string) => DAY_LONG.format(new Date(`${d}T12:00:00`));

function FixedScreen({ commitments, onChanged }: { commitments?: Commitments | null; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const { error, run } = useAction();
  const items = commitments?.items ?? [];
  const suggestions = commitments?.suggestions ?? [];
  return (
    <SubPage title="Fixed costs" help={commitments ? `${euroRound(commitments.limit)} a month. These come off before your budget.` : undefined}>
      <Card className="list">
        {!commitments && <p className="hint">Loading…</p>}
        {commitments && items.length === 0 && <p className="hint" style={{ margin: "10px 0" }}>None yet.</p>}
        {items.map((c) => (
          <a key={c.id} className="part" href={hrefFor({ page: "settings", section: "fixed", commitment: c.id })}>
            <span className="t"><b>{c.name}</b>
              <span className="muted small num">{c.every_months > 1 ? `${euroRound(c.amount ?? 0)} · ${everyLabel(c.every_months).toLowerCase()}${c.next_date ? ` · next ${dayLong(c.next_date)}` : ""}` : "Every month"}</span></span>
            <span className="amt num">{euroRound(c.monthly_limit)}<span>a month</span></span>
            <Icon icon="mdi:chevron-right" />
          </a>
        ))}
        <a className="part add-row" href={hrefFor({ page: "settings", section: "fixed", commitment: 0 })}><Icon icon="mdi:plus" />Add a cost</a>
      </Card>
      {suggestions.length > 0 && (
        <>
          <button className="btn ghost block" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? "Hide what's charged every month" : "Add something charged every month"}</button>
          {adding && (
            <Card className="list">
              {suggestions.map((s) => (
                <div key={s.service} className="part">
                  <span className="t"><b>{s.service}</b><span className="muted small num">About {euroRound(s.monthly)} a month</span></span>
                  <button className="chip" onClick={() => run(() => addCommitment({ name: s.service, kind: "fixed", monthly_limit: s.limit, note: "", services: [s.service], off_bank: 0 }).then(onChanged))}>Add</button>
                </div>
              ))}
            </Card>
          )}
        </>
      )}
      <p className="hint" style={{ margin: "0 4px" }}>A cost you pay every few months, like rent paid ahead or road tax, is spread over the months in between, so the month you pay it isn't hit.</p>
      {error && <div className="error">{error}</div>}
    </SubPage>
  );
}

/** One fixed cost: what you pay each time, how often, when next, and the payments it matches. id 0 adds one. */
function FixedCostScreen({ id, commitments, onChanged }: { id: number; commitments?: Commitments | null; onChanged: () => void }) {
  const c = commitments?.items.find((x) => x.id === id);
  if (!commitments) return <div className="skeleton" />;
  if (id && !c) return <SubPage title="Fixed cost"><div className="empty">This cost is gone.</div></SubPage>;
  return <FixedCostForm key={id} c={c} onChanged={onChanged} />;
}

/** What the form says, for a cost paid every month or one paid every few months. */
const COPY = {
  monthly: { per: "a month", recognised: "The payments it covers", noService: "Pick one" },
  periodic: { per: "each time", recognised: "If it's paid by card or direct debit. Transfers never count as spending.", noService: "Not needed" },
};

/** What you pay each time: the monthly limit, or for a cost every few months the amount paid then. */
const paidEachTime = (c: Commitment) => Math.round(c.every_months > 1 ? c.amount ?? 0 : c.monthly_limit);

/** The saved cost. One paid every few months counts as its share each month, to the cent; a monthly one has no
 * separate amount or next date. */
function toBody(c: Commitment | undefined, { name, every, v, next, service }: { name: string; every: number; v: number; next: string; service: string }) {
  const periodic = every > 1;
  return {
    name, kind: c?.kind ?? ("fixed" as const), note: c?.note ?? "", off_bank: c?.off_bank ?? 0,
    services: service ? [service, ...(c?.services.slice(1) ?? [])] : (c?.services.slice(1) ?? []),
    monthly_limit: periodic ? Math.round((v / every) * 100) / 100 : v, every_months: every, amount: periodic ? v : null, next_date: periodic ? next : null,
  };
}

function FixedCostForm({ c, onChanged }: { c?: Commitment; onChanged: () => void }) {
  const services = useApi<{ service: string; monthly: number; months: number; category: string }[]>("/api/commitments/services");
  const [name, setName] = useState(c?.name ?? "");
  const [every, setEvery] = useState(c?.every_months ?? 1);
  const [amount, setAmount] = useState(c ? paidEachTime(c).toLocaleString("en-GB") : "");
  const [next, setNext] = useState(c?.next_date ?? "");
  const [service, setService] = useState(c?.services[0] ?? "");
  const { error, run } = useAction();
  const [saved, setSaved] = useState(false);
  const v = parseAmount(amount);
  const periodic = every > 1;
  const copy = periodic ? COPY.periodic : COPY.monthly;
  const monthly = periodic ? v / every : v;
  const back = () => { location.hash = hrefFor({ page: "settings", section: "fixed" }); };
  const save = () => {
    const body = toBody(c, { name, every, v, next, service });
    run(() => (c ? editCommitment(c.id, body) : addCommitment(body))
      .then(() => { onChanged(); if (c) { setSaved(true); setTimeout(() => setSaved(false), 1500); } else back(); }));
  };
  const changedSomething = !c || name !== c.name || every !== c.every_months || next !== (c.next_date ?? "") || service !== (c.services[0] ?? "")
    || v !== paidEachTime(c);
  return (
    <>
      <nav className="crumbs" aria-label="Breadcrumb">
        <span className="crumb"><a href={hrefFor({ page: "settings" })}>Settings</a></span>
        <span className="crumb"><Icon icon="mdi:chevron-right" /><a href={hrefFor({ page: "settings", section: "fixed" })}>Fixed costs</a></span>
        <span className="crumb"><Icon icon="mdi:chevron-right" /><span aria-current="page">{c?.name ?? "New cost"}</span></span>
      </nav>
      <header className="hello"><h1>{c?.name ?? "New cost"}</h1></header>
      <div className="col">
        {!c && (
          <label className="fld"><span>What is it?</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rent" /></label>
        )}
        <label className="money-field">
          <span>€</span>
          <input className="num" inputMode="decimal" aria-label="Amount" value={amount} placeholder="0" onChange={(e) => setAmount(e.target.value)} />
          <em>{copy.per}</em>
        </label>
        <div className="group-label">How often</div>
        <div className="sp-seg" role="tablist" aria-label="How often">
          {OFTEN.map((o) => <button key={o.months} role="tab" aria-selected={every === o.months} onClick={() => setEvery(o.months)}>{o.label}</button>)}
        </div>
        <Card className="list">
          {periodic && (
            <label className="part"><span className="t"><b>Next payment</b></span>
              <input className="input" type="date" value={next} onChange={(e) => setNext(e.target.value)} aria-label="Next payment" style={{ width: 160 }} /></label>
          )}
          <label className="part"><span className="t"><b>Recognised as</b><span className="muted small gl-wrap">{copy.recognised}</span></span>
            <Select variant="sm" aria-label="Recognised as" value={service} onChange={(e) => setService(e.target.value)} style={{ maxWidth: 160 }}>
              <option value="">{copy.noService}</option>
              {service && !services.data?.some((s) => s.service === service) && <option value={service}>{service}</option>}
              {services.data?.map((s) => <option key={s.service} value={s.service}>{s.service}</option>)}
            </Select></label>
        </Card>
        {periodic && v > 0 && (
          <Card>
            <div className="label" style={{ marginTop: 0 }}>Counts as</div>
            <div className="sp-total num">{euroRound(monthly)}<small>a month</small></div>
            {c?.set_aside != null && c.every_months === every && (
              <>
                <span className="bar" style={{ marginTop: 14 }}><i style={{ width: `${Math.min(100, (c.set_aside / v) * 100)}%` }} /></span>
                <div className="pace-legend num" style={{ marginTop: 6 }}><span>{euroRound(c.set_aside)} put aside by now</span><span>of {euroRound(v)}</span></div>
              </>
            )}
            <p className="hint">Your budget takes {euroRound(monthly)} each month{next ? `. When the ${euroRound(v)} goes out on ${dayLong(next)}, it won't count as that month's spending.` : "."}</p>
          </Card>
        )}
        <button className="btn block" disabled={!changedSomething || !name.trim() || !v || (periodic && !next)} onClick={save}>{saved ? "Saved" : c ? "Save" : "Add cost"}</button>
        {c && (
          <button className="btn ghost block gl-stop" onClick={() => { if (confirm(`Remove ${c.name}?`)) deleteCommitment(c.id).then(() => { onChanged(); back(); }); }}>Remove {c.name}</button>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

function BudgetsScreen({ view, byId, onChanged }: { view: PlanView; byId: ScreenProps["byId"]; onChanged: () => void }) {
  const p = view.plan;
  const [draft, setDraft] = useState<Record<string, number>>(p?.budgets ?? {});
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(p?.budgets ?? {}), [p?.budgets]);
  if (!p) {
    return (
      <SubPage title="Category budgets">
        <Card><p className="hint" style={{ margin: 0 }}>Set your <a href={hrefFor({ page: "settings", section: "income" })}>monthly income</a> first.</p></Card>
      </SubPage>
    );
  }
  const auto = p.split === "auto";
  const spendable = p.take_home - p.keep - view.committed;
  const cats = Object.keys({ ...view.averages, ...p.budgets })
    .filter((c) => (p.budgets[c] ?? 0) > 0 || (view.averages[c] ?? 0) >= 5)
    .sort((a, b) => (p.budgets[b] ?? 0) - (p.budgets[a] ?? 0));
  const shown = showAll ? cats : cats.slice(0, 6);
  const total = Object.values(draft).reduce((s, v) => s + v, 0);
  const diff = Math.round(total - spendable);
  const dirty = cats.some((c) => Math.round(draft[c] ?? 0) !== Math.round(p.budgets[c] ?? 0));
  const setSplit = (split: "auto" | "custom") => { setBusy(true); savePlan(withPlan(view, { split })).then(onChanged).finally(() => setBusy(false)); };
  const saveCustom = () => { setBusy(true); savePlan(withPlan(view, { budgets: draft, split: "custom" })).then(onChanged).finally(() => setBusy(false)); };

  return (
    <SubPage title="Category budgets" help={`${euroRound(spendable)} a month to spend, after savings and fixed costs.`}>
      <div className="seg2" role="radiogroup" aria-label="How budgets are set">
        <button role="radio" aria-checked={auto} disabled={busy} onClick={() => !auto && setSplit("auto")}>Automatic</button>
        <button role="radio" aria-checked={!auto} disabled={busy} onClick={() => auto && setSplit("custom")}>Custom</button>
      </div>
      <Card className="list">
        <p className="small num" style={{ margin: "10px 0 4px" }}>
          {auto ? <span className="muted">Split the way you usually spend, trimming the extras most.</span>
            : diff === 0 ? <span className="muted">Adds up to {euroRound(spendable)}.</span>
            : <span className="over-txt">{euroRound(Math.abs(diff))} {diff > 0 ? "over" : "under"} the {euroRound(spendable)} you have.</span>}
        </p>
        {shown.map((c) => (
          <div key={c} className="part">
            <span className="ricon"><Icon icon={byId[c]?.icon ?? "mdi:dots-horizontal"} /></span>
            <span className="t"><b>{byId[c]?.label ?? c}</b></span>
            {auto ? <span className="val num">{euroRound(p.budgets[c] ?? 0)}</span> : (
              <input className="input money" inputMode="decimal" aria-label={`Budget for ${byId[c]?.label ?? c}`}
                value={draft[c] ? String(Math.round(draft[c])) : ""} placeholder="0"
                onChange={(e) => setDraft({ ...draft, [c]: parseAmount(e.target.value) })} />
            )}
          </div>
        ))}
        {cats.length > 6 && <button className="part add-row" onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : `Show all ${cats.length}`}</button>}
      </Card>
      {!auto && dirty && <button className="btn block" disabled={busy} onClick={saveCustom}>Save budgets</button>}
    </SubPage>
  );
}

/** One switch: alerts reach this phone, with cool-down alerts and Claude's weekly read on. */
function Notifications({ view, onChanged }: { view: PlanView; onChanged: () => void }) {
  const support = pushSupport();
  const [device, setDevice] = useState<boolean | null>(support === "ok" ? null : false);
  const { busy, error, run } = useAction();
  useEffect(() => { if (support === "ok") currentSubscription().then((s) => setDevice(!!s)).catch(() => setDevice(false)); }, [support]);
  const on = view.settings.alerts && (support !== "ok" || !!device);
  const toggle = () => run(() => {
    const push = support === "ok" ? (on ? disablePush().then(() => setDevice(false)) : enablePush().then(() => setDevice(true))) : Promise.resolve();
    return push.then(() => saveSettings({ alerts: !on, weekly_read: !on && view.ai })).then(onChanged);
  });
  return (
    <Card className="list">
      <div className="part">
        <span className="ricon"><Icon icon="mdi:bell-outline" /></span>
        <span className="t">
          <b>Notifications</b>
          {support === "install" && <span className="muted small text-wrap">On iPhone, add ebby to your home screen first: Share, then Add to Home Screen.</span>}
        </span>
        <button className="switch" role="switch" aria-checked={on} aria-label="Notifications" disabled={busy || device === null} onClick={toggle}><i /></button>
      </div>
      {error && <div className="error">{error}</div>}
    </Card>
  );
}

function Banks({ status }: { status?: Status }) {
  const live = status?.connections.filter((c) => c.connected) ?? [];
  const until = live.map((c) => c.valid_until).filter((d): d is string => !!d).sort()[0];
  const problem = !!status && (live.length === 0 || live.some((c) => c.last_error?.reconnect));
  return (
    <Card className="list">
      <a className="part" href={hrefFor({ page: "accounts" })}>
        <span className={`ricon ${problem ? "warn" : ""}`}><Icon icon={problem ? "mdi:alert-circle-outline" : "mdi:bank-outline"} /></span>
        <span className="t">
          <b>{live.length ? live.map((c) => c.bank).join(", ") : "Banks"}</b>
          <span className={`small ${problem ? "over-txt" : "muted"}`}>
            {!status ? "Loading…" : problem ? (live.length ? "One needs reconnecting" : "None connected") : until ? `Connected until ${BANK_DATE.format(new Date(until))}` : "Connected"}
          </span>
        </span>
        <Icon icon="mdi:chevron-right" />
      </a>
    </Card>
  );
}

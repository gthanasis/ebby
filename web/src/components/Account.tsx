import { useState, type FormEvent, type ReactNode } from "react";
import {
  invitePerson, removeCredential, saveAnthropicKey, saveSettings, signOut, updatePerson, useApi,
  type Me, type Person, type PersonStatus,
} from "../lib/api";
import { useAction } from "../lib/action";
import { hrefFor } from "./App";
import { EnableBankingSteps, KeyForm } from "./Onboarding";
import { Card, CardHeader, Icon } from "./ui";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const usd = (n: number) => `$${n.toFixed(2)}`;
/** The day the allowance starts again: the 1st of next month. */
const resetsOn = () => {
  const d = new Date();
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" }).format(new Date(d.getFullYear(), d.getMonth() + 1, 1));
};

export function Avatar({ name, email, picture, size = 44 }: { name: string | null; email: string; picture: string | null; size?: number }) {
  const initials = (name || email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * .36 }} aria-hidden="true">
      {picture ? <img src={picture} alt="" referrerPolicy="no-referrer" /> : initials}
    </span>
  );
}

/** Top of Settings: who's signed in, and the way out. */
export function AccountCard({ me }: { me: Me }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card className="list">
      <div className="part acct">
        <Avatar name={me.name} email={me.email} picture={me.picture} />
        <span className="t"><b>{me.name ?? me.email}</b>{me.name && <span className="muted small">{me.email}</span>}</span>
        <button className="chip" disabled={busy} onClick={() => { setBusy(true); signOut(); }}>
          <Icon icon={busy ? "mdi:sync" : "mdi:logout"} className={busy ? "spin" : ""} />Sign out
        </button>
      </div>
    </Card>
  );
}

export const aiValue = (me: Me) => me.credentials?.anthropic ? `Your key ${me.credentials.anthropic.masked}`
  : me.is_admin ? "No limit" : me.ai_spent_usd != null && me.ai_budget_usd != null ? `${usd(me.ai_spent_usd)} of ${usd(me.ai_budget_usd)}` : "Monthly allowance";

/** A screen inside Settings: the way back, its title and what it's for. */
export function SubPage({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <>
      <a className="back" href={hrefFor({ page: "settings" })}><Icon icon="mdi:chevron-left" />Settings</a>
      <header className="hello"><h1>{title}</h1>{help && <p>{help}</p>}</header>
      <div className="col">{children}</div>
    </>
  );
}

/** Ask before something that can't be taken back: what happens, then Remove / Cancel. */
function Confirm({ title, children, action, onConfirm, onCancel }: {
  title: string; children: ReactNode; action: string; onConfirm: () => Promise<unknown>; onCancel: () => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <div className="notice warn confirm" role="alertdialog" aria-label={title}>
      <Icon icon="mdi:alert-circle-outline" />
      <div>
        <b>{title}</b>
        <p className="muted">{children}</p>
        {error && <div className="error small">{error}</div>}
        <div className="row-actions">
          <button className="btn danger" disabled={busy} onClick={() => run(onConfirm, { keepBusy: true })}>
            {busy ? <><Icon icon="mdi:sync" className="spin" />Removing…</> : action}
          </button>
          <button className="btn ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Bank access: your Enable Banking app ---------- */
export function BankAccessScreen({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const key = me.credentials?.enable_banking;
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);

  if (!key) {
    return (
      <SubPage title="Bank access" help="ebby reads your banks through your own Enable Banking app. Add its key to connect banks again.">
        <EnableBankingSteps />
        <KeyForm onSaved={onChanged} />
      </SubPage>
    );
  }
  return (
    <SubPage title="Bank access" help="Your own Enable Banking app, which ebby uses to read your banks.">
      <Card>
        <CardHeader icon="mdi:key-outline" title="Enable Banking app" aside={<span className="pill-status ok"><Icon icon="mdi:check" />Working</span>} />
        <dl className="facts">
          <dt>Application ID</dt><dd className="num">{key.app_id}</dd>
          <dt>Key fingerprint</dt><dd className="num">{key.key_fingerprint}</dd>
          <dt>Last checked</dt><dd>{DAY.format(new Date(key.verified_at))}</dd>
        </dl>
        {!replacing && !removing && (
          <div className="row-actions">
            <button className="btn ghost" onClick={() => setReplacing(true)}><Icon icon="mdi:tray-arrow-up" />Replace key</button>
            <button className="btn ghost danger" onClick={() => setRemoving(true)}><Icon icon="mdi:delete-outline" />Remove</button>
          </div>
        )}
        {removing && (
          <Confirm title="Remove bank access?" action="Remove bank access" onCancel={() => setRemoving(false)}
            onConfirm={() => removeCredential("enable_banking").then(() => { setRemoving(false); onChanged(); })}>
            Your key is deleted and every bank stops syncing. You'll need to add a key and reconnect each bank to see new payments.
            Your history stays.
          </Confirm>
        )}
      </Card>
      {replacing && (
        <>
          <KeyForm title="Replace the key" onSaved={() => { setReplacing(false); onChanged(); }} />
          <button className="btn ghost block" onClick={() => setReplacing(false)}>Keep the current key</button>
        </>
      )}
    </SubPage>
  );
}

/* ---------- AI: the allowance on the shared key, or your own ---------- */
export function AiScreen({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const own = me.credentials?.anthropic;
  const [removing, setRemoving] = useState(false);
  const [key, setKey] = useState("");
  const { busy, error, run } = useAction();
  const save = (e: FormEvent) => {
    e.preventDefault();
    run(() => saveAnthropicKey(key.trim()).then(() => { setKey(""); onChanged(); }));
  };

  const budget = me.ai_budget_usd ?? 0, spent = me.ai_spent_usd;
  const used = spent != null && budget > 0 ? Math.min(spent / budget, 1) : 0;
  const out = spent != null && spent >= budget;

  return (
    <SubPage title="AI" help="The assistant answers questions about your money, explains your spending and helps sort payments.">
      {own ? (
        <Card>
          <CardHeader icon="mdi:key-outline" title="Your Anthropic key" aside={<span className="pill-status ok"><Icon icon="mdi:check" />No limit</span>} />
          <p className="ai-own num"><span>Key ending <b>{own.masked}</b></span><span className="muted small">Added {DAY.format(new Date(own.verified_at))}</span></p>
          {removing ? (
            <Confirm title="Remove your key?" action="Remove key" onCancel={() => setRemoving(false)}
              onConfirm={() => removeCredential("anthropic").then(() => { setRemoving(false); onChanged(); })}>
              {me.is_admin ? "The assistant goes back to the shared key." : `The assistant goes back to the monthly allowance of ${usd(budget)}.`}
            </Confirm>
          ) : (
            <div className="row-actions"><button className="btn ghost danger" onClick={() => setRemoving(true)}><Icon icon="mdi:delete-outline" />Remove key</button></div>
          )}
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader icon="mdi:creation-outline" title="This month" />
            {me.is_admin ? (
              <p className="muted ai-note">You're the admin, so the shared key has no limit for you.</p>
            ) : spent == null ? (
              <p className="muted ai-note">A monthly allowance of {usd(budget)} on the shared key. It resets on {resetsOn()}.</p>
            ) : (
              <>
                <div className="ai-spend num"><b>{usd(spent)}</b><span className="muted"> of {usd(budget)}</span></div>
                <span className="bar ai-bar" role="img" aria-label={`${usd(spent)} of ${usd(budget)} used`}>
                  <i className={out ? "over" : used > .8 ? "ahead" : ""} style={{ width: `${used * 100}%` }} />
                </span>
                <p className={`hint ${out ? "over-txt" : ""}`}>
                  {out ? `Used up. The assistant is paused until ${resetsOn()}, or add your own key below.` : `${usd(budget - spent)} left. Resets on ${resetsOn()}.`}
                </p>
              </>
            )}
          </Card>
          <Card>
            <CardHeader icon="mdi:key-outline" title="Use your own key" />
            <p className="hint ai-lead">With your own Anthropic API key the assistant has no monthly limit, and Anthropic bills you directly. Stored encrypted.</p>
            <form className="ob-row" onSubmit={save}>
              <input className="input ob-mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…"
                aria-label="Anthropic API key" autoComplete="off" spellCheck={false} disabled={busy} />
              <button className="btn" type="submit" disabled={busy || key.trim().length < 10}>
                {busy ? <Icon icon="mdi:sync" className="spin" /> : null}{busy ? "Checking…" : "Save"}
              </button>
            </form>
            {error && <div className="notice bad ob-notice" role="alert"><Icon icon="mdi:alert-circle-outline" /><div><b>Couldn't use this key</b><p className="muted">{error}</p></div></div>}
            <a className="link ai-console" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">Get a key at console.anthropic.com<Icon icon="mdi:open-in-new" /></a>
          </Card>
        </>
      )}
    </SubPage>
  );
}

/* ---------- Your names, as banks print them ---------- */
export function NamesScreen({ names, onChanged }: { names: string[]; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const { busy, error, run } = useAction();
  const save = (next: string[]) => run(() => saveSettings({ owner_names: next }).then(() => { setDraft(""); onChanged(); }));
  const add = (e: FormEvent) => {
    e.preventDefault();
    const n = draft.trim();
    if (!n) return;
    if (names.some((x) => x.toLowerCase() === n.toLowerCase())) { setDraft(""); return; }
    save([...names, n]);
  };
  return (
    <SubPage title="Your names" help="How your banks print your name on transfers. Money moving to these names is between your own accounts, so it doesn't count as spending.">
      <Card>
        {names.length ? (
          <div className="ob-names">
            {names.map((n) => (
              <span className="filterchip" key={n}>{n}
                <button type="button" aria-label={`Remove ${n}`} disabled={busy} onClick={() => save(names.filter((x) => x !== n))}><Icon icon="mdi:close" /></button>
              </span>
            ))}
          </div>
        ) : <p className="muted ai-note">No names yet, so transfers to your other accounts may show up as spending.</p>}
        <form className="ob-row" onSubmit={add}>
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a spelling" aria-label="Add a name" autoCapitalize="characters" disabled={busy} />
          <button className="btn ghost" type="submit" disabled={busy || !draft.trim()}><Icon icon="mdi:plus" />Add</button>
        </form>
        {error && <div className="error small">{error}</div>}
        <p className="hint">Add every spelling you've seen: with and without accents, surname first, Latin or Greek letters.</p>
      </Card>
    </SubPage>
  );
}

/* ---------- People (admin): who can sign in, and their AI allowance ---------- */
const STATUS: Record<PersonStatus, string> = { invited: "Invited", active: "Active", disabled: "Disabled" };

export function PeopleScreen({ me }: { me: Me }) {
  const people = useApi<Person[]>(me.is_admin ? "/api/people" : null);
  const [list, setList] = useState<Person[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const shown = list ?? people.data;

  if (!me.is_admin) return <SubPage title="People"><div className="error">Only the admin can manage people.</div></SubPage>;
  const active = shown?.filter((p) => p.status !== "disabled") ?? [];
  const spent = active.reduce((s, p) => s + p.ai_spent_usd, 0);

  return (
    <SubPage title="People" help="Who can sign in with Google, and how much AI each person can use on your key each month.">
      <InviteCard onInvited={() => { setList(null); people.reload(); }} />
      {people.error && <div className="error">{people.error}</div>}
      {!shown && !people.error && <div className="skeleton" />}
      {shown && (
        <>
          <div className="group-label num">{shown.length} {shown.length === 1 ? "person" : "people"} · {usd(spent)} of AI this month</div>
          <Card className="list">
            {shown.map((p) => (
              <PersonRow key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onList={setList} />
            ))}
          </Card>
          <p className="hint gl-note">People only ever see their own money. You see their AI spend, never their transactions.</p>
        </>
      )}
    </SubPage>
  );
}

function InviteCard({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState("");
  const { busy, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    run(() => invitePerson(email.trim()).then((p) => { setDone(p.email); setEmail(""); onInvited(); }));
  };
  return (
    <Card>
      <CardHeader icon="mdi:account-plus-outline" title="Invite someone" />
      <form className="ob-row" onSubmit={submit}>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their Google email"
          aria-label="Email to invite" autoComplete="off" autoCapitalize="off" disabled={busy} required />
        <button className="btn" type="submit" disabled={busy || !email.includes("@")}>{busy ? "Adding…" : "Invite"}</button>
      </form>
      {error && <div className="error small">{error}</div>}
      <p className={`hint ${done ? "ok-txt" : ""}`}>
        {done ? `${done} can sign in now. Send them the link: ${location.host}` : "They sign in with Google, then set up their own Enable Banking app. They start with a $2.00 monthly AI allowance."}
      </p>
    </Card>
  );
}

function PersonRow({ p, open, onToggle, onList }: { p: Person; open: boolean; onToggle: () => void; onList: (list: Person[]) => void }) {
  const [budget, setBudget] = useState(String(p.ai_budget_usd));
  const { busy, error, run } = useAction();
  const change = (c: { status?: "active" | "disabled"; ai_budget_usd?: number }) => run(() => updatePerson(p.id, c).then(onList));
  const value = Number(budget.replace(",", "."));
  const valid = budget.trim() !== "" && Number.isFinite(value) && value >= 0 && value <= 1000;
  const used = p.ai_budget_usd > 0 ? Math.min(p.ai_spent_usd / p.ai_budget_usd, 1) : 0;
  const seen = p.last_login_at ? `Last seen ${DAY.format(new Date(p.last_login_at))}` : "Hasn't signed in yet";

  return (
    <div className={`person ${open ? "open" : ""} ${p.status === "disabled" ? "off" : ""}`}>
      <button className="part" onClick={onToggle} aria-expanded={open}>
        <Avatar name={p.name} email={p.email} picture={p.picture} size={36} />
        <span className="t">
          <b>{p.name ?? p.email}{p.is_admin && <span className="tag">Admin</span>}</b>
          <span className="muted small">{p.name ? p.email : seen}</span>
        </span>
        <span className="amt num">
          <span className={`pill-status ${p.status}`}>{STATUS[p.status]}</span>
          <span className="sp-sub">{p.is_admin ? usd(p.ai_spent_usd) : `${usd(p.ai_spent_usd)} / ${usd(p.ai_budget_usd)}`}</span>
        </span>
        <Icon icon={open ? "mdi:chevron-down" : "mdi:chevron-right"} />
      </button>
      {open && (
        <div className="person-edit">
          {!p.is_admin && <span className="bar"><i className={used >= 1 ? "over" : used > .8 ? "ahead" : ""} style={{ width: `${used * 100}%` }} /></span>}
          <p className="muted small">{p.name ? `${seen}. ` : ""}On the list since {DAY.format(new Date(p.created_at))}.</p>
          {!p.is_admin && (
            <form className="ob-row" onSubmit={(e) => { e.preventDefault(); if (valid) change({ ai_budget_usd: value }); }}>
              <label className="money-in"><span>$</span>
                <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label={`Monthly AI allowance for ${p.email}`} disabled={busy} />
                <em>a month</em></label>
              <button className="btn ghost" type="submit" disabled={busy || !valid || value === p.ai_budget_usd}>Save</button>
            </form>
          )}
          {error && <div className="error small">{error}</div>}
          {p.is_admin ? <p className="hint">That's you. The admin can't be disabled and has no AI limit.</p> : (
            <div className="row-actions">
              {p.status === "disabled"
                ? <button className="btn ghost" disabled={busy} onClick={() => change({ status: "active" })}><Icon icon="mdi:account-check-outline" />Let them back in</button>
                : <button className="btn ghost danger" disabled={busy} onClick={() => change({ status: "disabled" })}><Icon icon="mdi:account-off-outline" />Disable</button>}
            </div>
          )}
          {p.status !== "disabled" && !p.is_admin && <p className="hint">Disabling signs them out everywhere at once. Their data stays.</p>}
        </div>
      )}
    </div>
  );
}

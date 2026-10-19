import { useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  finishOnboarding, saveAnthropicKey, saveBankAccess, saveSettings, startAuth, type BankAccess, type Me, type Status,
} from "../lib/api";
import { BankPicker } from "./BankPicker";
import { Logo } from "./Logo";
import { Card, CardHeader, Icon } from "./ui";

const STEPS = 5;
const EB_SITE = "https://enablebanking.com";
const EB_PANEL = "https://enablebanking.com/cp/applications";
const MAX_PEM = 16 * 1024;
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

/** #/welcome/step=2, or where /eb-callback sends you back: #/welcome/connected=Revolut&accounts=3 or #/welcome/error=… */
function welcomeParams() {
  return new URLSearchParams(location.hash.replace(/^#\/?welcome\/?/, ""));
}
const goStep = (n: number) => { location.hash = `#/welcome/step=${n}`; };

/** First run, after Google sign-in: bring your own Enable Banking app, connect a bank, two optional settings. */
export function Onboarding({ me, status, reloadMe, reloadStatus, onDone }: {
  me: Me; status?: Status; reloadMe: () => void; reloadStatus: () => void; onDone: () => void;
}) {
  const params = welcomeParams();
  const connected = status?.connections.filter((c) => c.connected).length ?? 0;
  const banks = Math.max(me.onboarding.banks_connected, connected);
  const access = me.onboarding.bank_access;
  // You can't skip ahead of the server: no key, no banks; no bank, nothing past it.
  const furthest = !access ? 2 : banks === 0 ? 3 : STEPS;
  const resume = !access ? 1 : banks === 0 ? 3 : 4;
  const asked = params.has("connected") || params.has("error") ? 3 : Number(params.get("step")) || resume;
  const step = Math.min(Math.max(asked, 1), furthest);

  return (
    <main className="login ob">
      <div className="login-sky" aria-hidden="true"><i /><i /><i /></div>
      <div className="login-grid" aria-hidden="true" />

      <div className="ob-body">
        <header className="ob-top">
          {step > 1
            ? <button className="back" onClick={() => goStep(step - 1)}><Icon icon="mdi:chevron-left" />Back</button>
            : <span />}
          <span className="small muted num">Step {step} of {STEPS}</span>
        </header>
        <div className="so-dots ob-dots" role="progressbar" aria-valuemin={1} aria-valuemax={STEPS} aria-valuenow={step} aria-label="Setup progress">
          {Array.from({ length: STEPS }, (_, i) => <i key={i} className={i + 1 < step ? "done" : i + 1 === step ? "cur" : ""} />)}
        </div>

        <div className="ob-step" key={step}>
          {step === 1 && <Welcome me={me} />}
          {step === 2 && <BankAccessStep hasAccess={access} existing={me.credentials?.enable_banking} redirectUrl={me.eb_redirect_url ?? `${location.origin}/eb-callback`} onSaved={reloadMe} />}
          {step === 3 && <ConnectStep status={status} params={params} banks={banks} reloadStatus={reloadStatus} />}
          {step === 4 && <QuickSettings me={me} />}
          {step === 5 && <Done status={status} onDone={onDone} />}
        </div>
      </div>
    </main>
  );
}

function Title({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ob-title">
      <h1>{title}</h1>
      <p className="login-lede">{children}</p>
    </div>
  );
}

/* ---------- 1. what's about to happen ---------- */
function Welcome({ me }: { me: Me }) {
  const first = me.name?.split(" ")[0];
  return (
    <>
      <div className="ob-hero">
        <div className="login-mark" aria-hidden="true"><Logo live /></div>
        <Title title={first ? `Welcome, ${first}` : "Welcome"}>
          ebby puts every bank you use in one place. Before your first look, it needs a way to read your accounts.
        </Title>
      </div>

      <Card className="list">
        <div className="part">
          <span className="ricon"><Icon icon="mdi:key-outline" /></span>
          <span className="t"><b>Your own Enable Banking app</b>
            <span className="muted small">Enable Banking is how ebby reads your banks. Everyone makes their own, and it's free.</span></span>
        </div>
        <div className="part">
          <span className="ricon"><Icon icon="mdi:bank-outline" /></span>
          <span className="t"><b>Connect your banks</b>
            <span className="muted small">Approve access in your bank's own app. ebby sees transactions and balances, and can't move money.</span></span>
        </div>
        <div className="part">
          <span className="ricon"><Icon icon="mdi:timer-outline" /></span>
          <span className="t"><b>About 10 minutes, once</b>
            <span className="muted small">Bank access lasts up to 180 days, then you renew it from Settings.</span></span>
        </div>
      </Card>

      <button className="btn block login-google ob-cta" onClick={() => goStep(2)}>Let's set it up<Icon icon="mdi:arrow-right" /></button>
      <p className="login-fine"><Icon icon="mdi:shield-check-outline" />Your keys are stored encrypted.</p>
      <form className="ob-who" method="post" action="/auth/logout">
        <span className="muted small">Signed in as {me.email}</span>
        <button className="link" type="submit">Sign out</button>
      </form>
    </>
  );
}

/* ---------- 2. Enable Banking app ID and key ---------- */
function BankAccessStep({ hasAccess, existing, redirectUrl, onSaved }: { hasAccess: boolean; existing?: BankAccess; redirectUrl: string; onSaved: () => void }) {
  const [saved, setSaved] = useState<BankAccess | null>(existing ?? null);
  const [replacing, setReplacing] = useState(false);
  const showForm = replacing || (!hasAccess && !saved);

  return (
    <>
      <Title title="Create your Enable Banking app">
        Enable Banking connects ebby to your banks. In restricted mode it's free and reaches only your own accounts.
      </Title>

      <EnableBankingSteps redirectUrl={redirectUrl} />

      {showForm ? (
        <KeyForm onSaved={(r) => { setSaved(r); setReplacing(false); onSaved(); }} />
      ) : (
        <Card>
          <div className="status ob-status">
            <Icon icon="mdi:check-circle-outline" />
            <div>
              <b>{saved ? "Enable Banking accepted your key" : "Your Enable Banking app is connected"}</b>
              {saved ? (
                <dl className="ob-facts">
                  <dt>Application ID</dt><dd className="num">{saved.app_id}</dd>
                  <dt>Key fingerprint</dt><dd className="num">{saved.key_fingerprint}</dd>
                  <dt>Checked</dt><dd>{DATE.format(new Date(saved.verified_at))}</dd>
                </dl>
              ) : <p>The key is stored encrypted. You can replace it any time.</p>}
            </div>
          </div>
          <div className="ob-actions">
            <button className="btn block" onClick={() => goStep(3)}>Continue<Icon icon="mdi:arrow-right" /></button>
            <button className="btn ghost block" onClick={() => setReplacing(true)}>Use a different key</button>
          </div>
        </Card>
      )}
    </>
  );
}

/** What to do in Enable Banking's control panel before the key can be added here. */
/** redirectUrl: what to allow on the Enable Banking app; the server says (EB_REDIRECT_URL), else this address. */
export function EnableBankingSteps({ redirectUrl = `${location.origin}/eb-callback` }: { redirectUrl?: string }) {
  return (
    <Card>
      <CardHeader icon="mdi:format-list-bulleted" title="In Enable Banking" />
      <ol className="ob-steps">
        <li><b>Create an account</b>
          <span>Sign up with the email you use for your banks.</span>
          <a className="link" href={EB_SITE} target="_blank" rel="noreferrer">Open enablebanking.com<Icon icon="mdi:open-in-new" /></a></li>
        <li><b>Create an application in restricted mode</b>
          <span>In the control panel, add an application and keep it in restricted mode. It's free and only reaches accounts you link.</span>
          <a className="link" href={EB_PANEL} target="_blank" rel="noreferrer">Open the control panel<Icon icon="mdi:open-in-new" /></a></li>
        <li><b>Link your bank accounts</b>
          <span>Open the application and link every account you want to see here. Accounts you don't link can't connect.</span></li>
        <li><b>Allow the redirect URL</b>
          <span>Add this as an allowed redirect URL, so your bank can send you back here.</span>
          <CopyField value={redirectUrl} /></li>
        <li><b>Download the private key</b>
          <span>Enable Banking gives you a <code>.pem</code> file for the application. Keep it for the next part.</span></li>
      </ol>
    </Card>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  return (
    <span className="ob-copy">
      <code>{value}</code>
      <button className="chip" type="button" onClick={copy} aria-live="polite">
        <Icon icon={copied ? "mdi:check" : "mdi:content-copy"} />{copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

/** Application ID + .pem, checked live with Enable Banking before it's stored. */
export function KeyForm({ title = "Add it to ebby", onSaved }: { title?: string; onSaved: (r: BankAccess) => void }) {
  const [appId, setAppId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > MAX_PEM) { setFile(null); setError(`${f.name} is too big to be a key. Pick the .pem file Enable Banking gave you.`); return; }
    setFile(f);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setError(null);
    saveBankAccess(appId.trim(), file).then(onSaved).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
  };

  return (
    <Card>
      <CardHeader icon="mdi:key-outline" title={title} />
      <form className="form" onSubmit={submit}>
        <label className="fld">
          <span>Application ID</span>
          <input className="input ob-mono" value={appId} onChange={(e) => setAppId(e.target.value)} disabled={busy}
            placeholder="3f2b8c1e-…" autoComplete="off" autoCapitalize="off" spellCheck={false} required />
        </label>
        <div className="fld">
          <span id="pem-label">Private key</span>
          <label className={`ob-drop ${over ? "over" : ""} ${file ? "has" : ""}`} aria-labelledby="pem-label"
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}>
            <input ref={input} type="file" className="ob-file" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
            <span className="ricon"><Icon icon={file ? "mdi:file-key-outline" : "mdi:tray-arrow-up"} /></span>
            {file ? (
              <span className="t"><b>{file.name}</b><span className="muted small">{file.size < 1024 ? `${file.size} bytes` : `${(file.size / 1024).toFixed(1)} KB`} · choose another</span></span>
            ) : (
              <span className="t"><b>Choose your .pem file</b><span className="muted small ob-desk">or drop it here</span></span>
            )}
          </label>
        </div>

        {error && (
          <div className="notice bad ob-notice" role="alert">
            <Icon icon="mdi:alert-circle-outline" />
            <div><b>Couldn't use this key</b><p className="muted">{error}</p></div>
          </div>
        )}

        <button className="btn block" type="submit" disabled={busy || !file || !appId.trim()} aria-busy={busy}>
          {busy ? <><Icon icon="mdi:sync" className="spin" />Checking with Enable Banking…</> : <><Icon icon="mdi:lock-outline" />Check and save</>}
        </button>
        <p className="hint ob-center">We try the key with Enable Banking before saving it. It's stored encrypted and never shown again.</p>
      </form>
    </Card>
  );
}

/* ---------- 3. at least one bank ---------- */
function ConnectStep({ status, params, banks, reloadStatus }: { status?: Status; params: URLSearchParams; banks: number; reloadStatus: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ bank: string; message: string } | null>(null);
  const justConnected = params.get("connected");
  const failed = params.get("error");

  const connect = (bank: string) => {
    setBusy(bank); setError(null);
    startAuth(bank)
      .then((r) => { location.href = r.url; })
      .catch((e: Error) => { setError({ bank, message: e.message }); setBusy(null); reloadStatus(); });
  };

  return (
    <>
      <Title title="Connect a bank">
        Your bank asks you to approve access, then sends you straight back here. Connect every bank you use, or one now and the rest later.
      </Title>

      {justConnected && (
        <div className="status ob-status" role="status">
          <Icon icon="mdi:check-circle-outline" />
          <div><b>Connected {params.get("accounts") ?? ""} {justConnected} {params.get("accounts") === "1" ? "account" : "accounts"}</b>
            <p>Fetching your history now. Connect another bank, or continue.</p></div>
        </div>
      )}
      {failed && (
        <div className="notice bad ob-notice" role="alert">
          <Icon icon="mdi:alert-circle-outline" />
          <div><b>Couldn't connect</b><p className="muted">{failed}</p></div>
        </div>
      )}

      {status && status.connections.length > 0 && (
        <Card className="list">
          {status.connections.map((c) => {
            const accounts = status.accounts.filter((a) => a.bank === c.bank).length;
            return (
              <div className="part" key={c.bank}>
                <span className={`ricon ${c.connected ? "ob-on" : ""}`}><Icon icon={c.connected ? "mdi:check" : "mdi:bank-outline"} /></span>
                <span className="t">
                  <b>{c.bank}</b>
                  <span className="muted small">{c.connected ? (accounts ? `Connected · ${accounts} ${accounts === 1 ? "account" : "accounts"}` : "Connected") : "Not finished"}</span>
                  {error?.bank === c.bank && <span className="error small">{error.message}</span>}
                </span>
                <button className="chip" disabled={busy != null} onClick={() => connect(c.bank)} aria-busy={busy === c.bank}>
                  {busy === c.bank ? "Opening…" : c.connected ? "Reconnect" : "Try again"}
                </button>
              </div>
            );
          })}
        </Card>
      )}

      <Card>
        <BankPicker connected={status?.connections.map((c) => c.bank) ?? []} primary={banks === 0} />
      </Card>

      <div className="ob-actions">
        <button className="btn block" disabled={banks === 0} onClick={() => goStep(4)} aria-describedby="connect-why">
          Continue<Icon icon="mdi:arrow-right" />
        </button>
        <p className="hint ob-center" id="connect-why">
          {banks === 0 ? "Connect at least one bank to continue. Without one there's nothing to show you." : "You can add more banks later in Settings."}
        </p>
      </div>
    </>
  );
}

/* ---------- 4. optional: your names, your own AI key ---------- */
function QuickSettings({ me }: { me: Me }) {
  const [names, setNames] = useState<string[]>(me.name ? [me.name] : []);
  const [draft, setDraft] = useState("");
  const [key, setKey] = useState("");
  const [masked, setMasked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ on: "names" | "key"; message: string } | null>(null);

  const add = () => {
    const n = draft.trim();
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) setNames([...names, n]);
    setDraft("");
  };
  const save = async () => {
    setBusy(true); setError(null);
    const all = draft.trim() ? [...names, draft.trim()] : names;
    try {
      await saveSettings({ owner_names: all }).catch((e: Error) => { throw { on: "names", message: e.message }; });
      if (key.trim()) {
        const r = await saveAnthropicKey(key.trim()).catch((e: Error) => { throw { on: "key", message: e.message }; });
        setMasked(r.masked); setKey("");
      }
      goStep(5);
    } catch (e) {
      setError(e as { on: "names" | "key"; message: string });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Title title="Two quick things">Both optional. You can change them later in Settings.</Title>

      <Card>
        <CardHeader icon="mdi:account-outline" title="Your names" />
        <p className="hint ob-lead">How your banks print your name on transfers. ebby uses them to tell money moving between your own accounts apart from spending.</p>
        {names.length > 0 && (
          <div className="ob-names">
            {names.map((n) => (
              <span className="filterchip" key={n}>{n}
                <button type="button" aria-label={`Remove ${n}`} onClick={() => setNames(names.filter((x) => x !== n))}><Icon icon="mdi:close" /></button>
              </span>
            ))}
          </div>
        )}
        <form className="ob-row" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add another spelling" aria-label="Add a name" autoCapitalize="characters" />
          <button className="btn ghost" type="submit" disabled={!draft.trim()}><Icon icon="mdi:plus" />Add</button>
        </form>
        {error?.on === "names" && <div className="error small">{error.message}</div>}
      </Card>

      <Card>
        <CardHeader icon="mdi:creation-outline" title="Assistant" />
        <p className="hint ob-lead">The assistant answers questions about your money and helps sort payments. It comes with a monthly allowance. Add your own Anthropic API key to use it without a limit.</p>
        {masked ? (
          <div className="status ob-status"><Icon icon="mdi:check-circle-outline" /><div><b>Using your key</b><p>Key ending {masked}</p></div></div>
        ) : (
          <label className="fld">
            <span>Anthropic API key (optional)</span>
            <input className="input ob-mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…"
              autoComplete="off" spellCheck={false} disabled={busy} />
          </label>
        )}
        {error?.on === "key" && (
          <div className="notice bad ob-notice" role="alert"><Icon icon="mdi:alert-circle-outline" /><div><b>Couldn't use this key</b><p className="muted">{error.message}</p></div></div>
        )}
      </Card>

      <div className="ob-actions">
        <button className="btn block" onClick={save} disabled={busy} aria-busy={busy}>
          {busy ? <><Icon icon="mdi:sync" className="spin" />Saving…</> : <>Continue<Icon icon="mdi:arrow-right" /></>}
        </button>
        <button className="btn ghost block" onClick={() => goStep(5)} disabled={busy}>Skip for now</button>
      </div>
    </>
  );
}

/* ---------- 5. done ---------- */
function Done({ status, onDone }: { status?: Status; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const banks = status?.connections.filter((c) => c.connected).map((c) => c.bank) ?? [];
  const finish = () => {
    setBusy(true); setError(null);
    finishOnboarding().then(onDone).catch((e: Error) => { setError(e.message); setBusy(false); });
  };

  return (
    <>
      <div className="ob-hero">
        <div className="ob-done" aria-hidden="true"><Icon icon="mdi:check" /></div>
        <Title title="You're all set">
          Your first sync is running. Fetching your history takes a few minutes, and Overview fills in as it lands.
        </Title>
      </div>

      {banks.length > 0 && (
        <Card className="list">
          {banks.map((b) => (
            <div className="part" key={b}>
              <span className="ricon"><Icon icon="mdi:bank-outline" /></span>
              <span className="t"><b>{b}</b></span>
              <span className="muted small ob-sync">
                {status?.syncing ? <><Icon icon="mdi:sync" className="spin" />Syncing</> : <><Icon icon="mdi:check" />Connected</>}
              </span>
            </div>
          ))}
        </Card>
      )}

      {error && <div className="notice bad ob-notice" role="alert"><Icon icon="mdi:alert-circle-outline" /><div><b>Couldn't finish</b><p className="muted">{error}</p></div></div>}
      <button className="btn block login-google ob-cta" onClick={finish} disabled={busy} aria-busy={busy}>
        {busy ? <><Icon icon="mdi:sync" className="spin" />Opening…</> : <>Go to Overview<Icon icon="mdi:arrow-right" /></>}
      </button>
    </>
  );
}

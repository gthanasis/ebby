import { useState } from "react";
import { completeAuth, startAuth, type Account, type Connection, type Status } from "../lib/api";
import { ago, daysUntil, euro } from "../lib/format";
import { BankPicker } from "./BankPicker";
import { Card, CardHeader, Icon } from "./ui";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** Result of a bank redirect handled by /eb-callback, carried in the hash: #/accounts/connected=Revolut&accounts=5 */
function callbackResult() {
  const params = new URLSearchParams(location.hash.replace(/^#\/?accounts\/?/, ""));
  return { connected: params.get("connected"), accounts: params.get("accounts"), error: params.get("error") };
}

export function Accounts({ status, reload }: { status?: Status; reload: () => void }) {
  if (!status) return null;
  const result = callbackResult();
  return (
    <div className="grid">
      <div className="col">
        {result.connected && (
          <div className="notice"><Icon icon="mdi:sync" /><div><b>Connected {result.accounts} {result.connected} accounts</b>
            <p className="muted">Fetching your history now. This takes a few minutes.</p></div></div>
        )}
        {result.error && (
          <div className="notice bad"><Icon icon="mdi:alert-circle-outline" /><div><b>Couldn't connect</b><p className="muted">{result.error}</p></div></div>
        )}
        {status.connections.map((c) => (
          <ConnectionCard key={c.bank} c={c} syncHours={status.sync_hours} inApp={status.callback_in_app} onDone={reload} />
        ))}
        <Card>
          <CardHeader icon="mdi:plus" title={status.connections.length ? "Connect another bank" : "Connect a bank"} />
          <BankPicker connected={status.connections.map((c) => c.bank)} primary={!status.connections.some((c) => c.connected)} />
        </Card>
      </div>
      <div className="col">
        {status.connections.filter((c) => c.connected).map((c) => {
          const accounts = status.accounts.filter((a) => a.bank === c.bank);
          return (
            <Card key={c.bank}>
              <CardHeader icon="mdi:bank-outline" title={c.bank} />
              {accounts.length === 0 && <div className="chart-empty">No accounts shared. Link them in the Enable Banking control panel.</div>}
              {accounts.map((a) => <AccountRow key={a.id} a={a} />)}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ConnectionCard({ c, syncHours, inApp, onDone }: { c: Connection; syncHours: number; inApp: boolean; onDone: () => void }) {
  const left = daysUntil(c.valid_until);
  const expired = c.last_error?.reconnect || (left != null && left < 0);
  const soon = left != null && left < 14;
  return (
    <Card>
      <CardHeader icon="mdi:link-variant" title={c.bank} />
      {!c.connected ? (
        <div className="notice"><Icon icon="mdi:bank-outline" /><div><b>Not connected</b><p className="muted">Connect to include {c.bank} in your spending.</p></div></div>
      ) : expired ? (
        <div className="notice bad"><Icon icon="mdi:alert-circle-outline" /><div><b>Access expired</b>
          <p className="muted">{c.bank} needs you to approve access again. It won't sync until you do.</p></div></div>
      ) : (
        <div className={`notice ${soon ? "warn" : ""}`}>
          <Icon icon={soon ? "mdi:alert-circle-outline" : "mdi:sync"} />
          <div>
            <b>{syncHours > 48 ? "Background sync is off" : `Syncing every ${syncHours} hours`}</b>
            <p className="muted">
              Last sync {ago(c.last_sync)}. Access is valid until {c.valid_until ? DATE.format(new Date(c.valid_until)) : "–"}
              {left != null && ` (${left} days)`}.
            </p>
          </div>
        </div>
      )}
      {c.last_error && !expired && (
        <div className="notice warn"><Icon icon="mdi:alert-circle-outline" /><div><b>Last sync failed {ago(c.last_error.at)}</b>
          <p className="muted">{c.last_error.message}. It retries on the next scheduled sync.</p></div></div>
      )}
      <Reconnect bank={c.bank} primary={!c.connected || expired || soon} connected={c.connected} inApp={inApp} onDone={onDone} />
    </Card>
  );
}

function AccountRow({ a }: { a: Account }) {
  return (
    <div className="part">
      <span className="ricon"><Icon icon={a.is_card ? "mdi:credit-card-outline" : "mdi:bank-outline"} /></span>
      <span className="t">
        <b>{a.name}{a.last4 ? ` ·· ${a.last4}` : ""}</b>
        <span className="muted small">{a.transactions} transactions{a.since ? ` since ${DATE.format(new Date(a.since))}` : ""}</span>
      </span>
      <span className="amt num">{a.balance != null ? euro(a.balance) : ""}</span>
    </div>
  );
}

/** With the app's own /eb-callback, the bank sends you straight back. Otherwise (localhost redirect) the
 * bank lands on an address that doesn't load, and pasting it here finishes the link. */
function Reconnect({ bank, primary, connected, inApp, onDone }: {
  bank: string; primary: boolean; connected: boolean; inApp: boolean; onDone: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (done != null) {
    return <div className="notice"><Icon icon="mdi:sync" /><div><b>Connected {done} {bank} accounts</b><p className="muted">Fetching your history now. This takes a few minutes.</p></div></div>;
  }
  if (!url) {
    return (
      <div className="field">
        <button className={primary ? "btn" : "chip"} disabled={busy} onClick={() => {
          setBusy(true); setError(null);
          startAuth(bank)
            .then((r) => { if (inApp) location.href = r.url; else { setUrl(r.url); setBusy(false); } })
            .catch((e: Error) => { setError(e.message); setBusy(false); });
        }}>
          <Icon icon="mdi:link-variant" />{connected ? (primary ? `Reconnect ${bank}` : "Renew access now") : `Connect ${bank}`}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    );
  }
  return (
    <ol className="steps">
      <li>
        <a className="link" href={url} target="_blank" rel="noreferrer">Open {bank} and approve access<Icon icon="mdi:open-in-new" /></a>
      </li>
      <li>
        You'll land on a page that can't load. Copy its address from the address bar and paste it here.
        <form className="field" onSubmit={(e) => {
          e.preventDefault();
          setBusy(true); setError(null);
          completeAuth(address).then((r) => { setDone(r.accounts); onDone(); }).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
        }}>
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://localhost/eb-callback?state=…" aria-label="Address you landed on" />
          <button className="btn" type="submit" disabled={busy || !address.includes("code=")}>Finish</button>
        </form>
        {error && <div className="error">{error}</div>}
      </li>
    </ol>
  );
}

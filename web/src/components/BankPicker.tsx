import { useState } from "react";
import { startAuth, useApi, type BankList } from "../lib/api";
import { Icon } from "./ui";

/** Every bank Enable Banking connects in the country, searchable. Connecting sends you to the bank to approve,
 * which brings you back to /eb-callback. `connected` are left out: they're listed where this is used. */
export function BankPicker({ connected, primary }: { connected: string[]; primary: boolean }) {
  const list = useApi<BankList>("/api/banks");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ bank: string; message: string } | null>(null);

  const connect = (bank: string) => {
    setBusy(bank); setError(null);
    startAuth(bank)
      .then((r) => { location.href = r.url; })
      .catch((e: Error) => { setError({ bank, message: e.message }); setBusy(null); });
  };

  const words = q.trim().toLowerCase();
  const shown = (list.data?.banks ?? []).filter((b) => !connected.includes(b.name) && b.name.toLowerCase().includes(words));

  return (
    <div className="bank-picker">
      <label className="search">
        <Icon icon="mdi:magnify" />
        <input type="search" placeholder="Search banks, e.g. Piraeus" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search banks" />
      </label>
      {list.error && <p className="error small">{list.error}</p>}
      {!list.data && !list.error && <div className="sp-skel" />}
      {list.data && shown.length === 0 && (
        <div className="empty small"><Icon icon="mdi:bank-outline" />{words ? `No bank called “${q.trim()}” on Enable Banking.` : "Every bank is already connected."}</div>
      )}
      <div className="bank-list">
        {shown.map((b) => (
          <div className="part" key={b.name}>
            {b.logo ? <img className="bank-logo" src={b.logo} alt="" loading="lazy" /> : <span className="ricon"><Icon icon="mdi:bank-outline" /></span>}
            <span className="t">
              <b>{b.name}</b>
              {error?.bank === b.name && <span className="error small text-wrap">{error.message}</span>}
            </span>
            <button className={primary ? "btn" : "chip"} disabled={busy != null} onClick={() => connect(b.name)} aria-busy={busy === b.name}>
              <Icon icon={busy === b.name ? "mdi:sync" : "mdi:link-variant"} className={busy === b.name ? "spin" : ""} />
              {busy === b.name ? "Opening…" : "Connect"}
            </button>
          </div>
        ))}
      </div>
      <p className="hint">Only banks whose accounts you linked to your Enable Banking application will connect.</p>
    </div>
  );
}

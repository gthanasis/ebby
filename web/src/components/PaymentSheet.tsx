import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { pinPayment, remember, request, setCategory, type Category, type Payment } from "../lib/api";
import { useAction } from "../lib/action";
import { euro, shortDay } from "../lib/format";
import { hrefFor } from "./App";
import { Icon, Select } from "./ui";

const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const day = (d: string) => DAY.format(new Date(`${d}T12:00:00`));

/** Opens a payment's sheet from any list: the bottom of every drill-down. */
const OpenPayment = createContext<(id: string) => void>(() => {});
export const useOpenPayment = () => useContext(OpenPayment);

/** Holds the one sheet the app shows at a time. changed: reload the screens once something about a payment moved. */
export function PaymentSheetHost({ byId, changed, children }: { byId: Record<string, Category>; changed: () => void; children: ReactNode }) {
  const [id, setId] = useState<string | null>(null);
  // The phone's back gesture closes the sheet rather than leaving the screen under it.
  useEffect(() => {
    if (!id) return;
    const close = () => setId(null);
    addEventListener("hashchange", close);
    return () => removeEventListener("hashchange", close);
  }, [id]);
  return (
    <OpenPayment.Provider value={setId}>
      {children}
      {id && <PaymentSheet id={id} byId={byId} onChanged={changed} onClose={() => setId(null)} />}
    </OpenPayment.Provider>
  );
}

/** One payment: both days, the account, its category and fixed cost to change, and a note for the assistant. */
function PaymentSheet({ id, byId, onChanged, onClose }: { id: string; byId: Record<string, Category>; onChanged: () => void; onClose: () => void }) {
  const [p, setP] = useState<Payment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [others, setOthers] = useState<{ category: string; count: number; merchant: string } | null>(null);
  const [note, setNote] = useState("");
  const [kept, setKept] = useState(false);
  const { busy, error: actionError, run } = useAction();
  const load = () => request<Payment>(`/api/payment?id=${encodeURIComponent(id)}`).then(setP).catch((e: Error) => setError(e.message));
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);

  const cat = p ? byId[p.category] : undefined;
  const move = (category: string, all = false) => run(() => setCategory(id, category, all).then((r) => {
    setOthers(!all && r.merchant && r.others > 0 ? { category, count: r.others, merchant: r.merchant } : null);
    onChanged();
    return load();
  }));
  const pin = (value: string) => run(() => pinPayment(id, value === "" ? null : Number(value)).then((r) => { setP(r); onChanged(); }));
  const keep = () => run(() => remember(note, p?.name ?? null).then(() => { setKept(true); setNote(""); }));
  const ask = () => {
    if (!p) return;
    try { sessionStorage.setItem("assistantDraft", `About the ${euro(Math.abs(p.amount))} payment to ${p.name} on ${shortDay(p.date)}: `); } catch { /* the chat just opens empty */ }
    location.hash = hrefFor({ page: "assistant" });
  };

  return (
    <div className="so-sheet-bg" onClick={onClose}>
      <div className="so-sheet pay-sheet" role="dialog" aria-label={p ? `Payment to ${p.name}` : "Payment"} onClick={(e) => e.stopPropagation()}>
        <div className="so-sh">
          <span />
          <button className="chip icon-only" aria-label="Close" onClick={onClose}><Icon icon="mdi:close" /></button>
        </div>
        {error && <div className="error">{error}</div>}
        {!p && !error && <><div className="sp-skel" /><div className="sp-skel short" /></>}
        {p && (
          <>
            <div className="pay-head">
              <span className="ricon"><Icon icon={cat?.icon ?? "mdi:dots-horizontal"} /></span>
              <div className="t"><b>{p.name}</b>{p.description && p.description !== p.name && <span className="muted small">{p.description}</span>}</div>
              <div className={`pay-amt num ${p.amount > 0 ? "in" : ""}`}>{p.amount > 0 ? "+" : ""}{euro(Math.abs(p.amount))}</div>
            </div>
            <div className="sum pay-kv">
              <span>Paid</span><b>{day(p.date)}</b>
              {p.booked && <><span>Booked by the bank</span><b>{day(p.booked)}</b></>}
              {p.status === "PDNG" && <><span>Status</span><b className="over-txt">Pending</b></>}
              <span>Account</span><b>{p.account.name}{p.account.last4 ? ` ••${p.account.last4}` : ""}</b>
              <span>Category</span>
              <b><Select variant="sm" aria-label="Category" value={p.category} disabled={busy} onChange={(e) => move(e.target.value)}>
                {Object.values(byId).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select></b>
              <span>Fixed cost</span>
              <b><Select variant="sm" aria-label="Fixed cost" value={p.commitment_id ?? ""} disabled={busy} onChange={(e) => pin(e.target.value)}>
                <option value="">None, it's spending</option>
                {p.costs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select></b>
            </div>
            {p.commitment && (
              <p className="hint">
                {p.pinned ? `Linked to ${p.commitment} by hand.` : `Every ${p.name} payment goes to ${p.commitment}.`} It counts as a fixed cost, not as spending.
              </p>
            )}
            {others && (
              <div className="notice">
                <Icon icon="mdi:swap-horizontal" />
                <div>
                  <b>Only this payment moved</b>
                  <p className="num">{others.count} other {others.merchant} {others.count === 1 ? "payment is" : "payments are"} still elsewhere.</p>
                  <div className="row-actions"><button className="chip" disabled={busy} onClick={() => move(others.category, true)}>Move {others.count === 1 ? "it" : "them"} to {byId[others.category]?.label ?? others.category} too</button></div>
                </div>
              </div>
            )}
            <div className="pay-memory">
              <label htmlFor="pay-note" className="small muted">Tell the assistant, for next time</label>
              <textarea id="pay-note" rows={2} placeholder="e.g. what this was, or how to sort payments like it" value={note} onChange={(e) => { setNote(e.target.value); setKept(false); }} />
              <div className="row-actions">
                <button className="btn" disabled={busy || !note.trim()} onClick={keep}><Icon icon="mdi:creation-outline" />Remember</button>
                <button className="btn ghost" onClick={ask}><Icon icon="mdi:message-text-outline" />Ask the assistant</button>
              </div>
              {kept && <p className="hint ok-txt">Remembered. It reads this next time it sorts {p.name}. Change it in Settings, under Assistant.</p>}
            </div>
            {actionError && <div className="error">{actionError}</div>}
          </>
        )}
      </div>
    </div>
  );
}

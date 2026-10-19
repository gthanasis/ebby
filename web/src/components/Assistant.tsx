import { useEffect, useRef, useState } from "react";
import {
  ApiError, cancelAction, confirmAction, newChat, streamChat, useApi,
  type AssistantState, type ChatItem,
} from "../lib/api";
import { euroRound } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { ErrorNote, Icon } from "./ui";

const STARTERS = ["How much did I spend on Wolt this month?", "20 bakery cash", "Where does my cash go?", "Can I afford €900 for Lisbon in March?"];

/** The one place you type to the app: its questions first, then the chat. */
export function AssistantScreen({ version, onChanged }: ScreenProps & { onChanged: () => void }) {
  const { data, error, reload } = useApi<AssistantState>("/api/assistant", version);
  const [items, setItems] = useState<ChatItem[]>([]);
  // A question handed over from elsewhere (the sorter's "Ask"), ready to send or edit.
  const [text, setText] = useState(() => { try { const d = sessionStorage.getItem("assistantDraft") ?? ""; sessionStorage.removeItem("assistantDraft"); return d; } catch { return ""; } });
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<unknown>(null);
  // While Claude answers: the words so far, and what it's looking up.
  const [live, setLive] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { if (data) setItems(data.items); }, [data]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end", behavior: "smooth" }); }, [items.length, busy, live.length > 0]);

  const send = (t: string) => {
    const msg = t.trim();
    if (!msg || busy) return;
    setText(""); setFail(null); setBusy(true);
    setItems((xs) => [...xs, { type: "me", text: msg }]);
    setLive(""); setStatus(null);
    streamChat(msg, (e) => {
      if (e.type === "text") { setLive((t) => t + e.text); setStatus(null); }
      else if (e.type === "status") { setLive(""); setStatus(e.text); }
      else if (e.type === "error") { setFail(e.code === "allowance" ? new ApiError(e.text, 429) : e.text); reload(); }
      else { setItems(e.items); setLive(""); onChanged(); }
    }).catch((e: Error) => { setFail(e); reload(); })
      .finally(() => { setBusy(false); setLive(""); setStatus(null); });
  };

  return (
    <div className="assistant">
      <header className="hello top">
        <div><h1>Assistant</h1><p>Ask, log cash, or tell it what to change</p></div>
        {items.length > 0 && (
          <button className="chip" onClick={() => newChat().then((r) => setItems(r.items))}><Icon icon="mdi:plus" />New chat</button>
        )}
      </header>
      {error && <div className="error">{error}</div>}
      {data && data.questions.length > 0 && (
        <a className="so-entry" href={hrefFor({ page: "assistant", section: "sort" })}>
          <span className="ricon warn"><Icon icon="mdi:help-circle-outline" /></span>
          <span className="t"><b>{data.questions.length} {data.questions.length === 1 ? "payment needs" : "payments need"} a category</b>
            <span className="muted small">Takes about a minute</span></span>
          <Icon icon="mdi:chevron-right" />
        </a>
      )}
      {data && data.cash.unaccounted > 0 && (
        <div className="cashline num">
          <Icon icon="mdi:cash" />
          <span><b>{euroRound(data.cash.unaccounted)}</b> of this month's cash isn't accounted for. Tell me what it went on, e.g. "20 bakery".</span>
        </div>
      )}
      {data && !data.ai && (
        <ErrorNote error={new ApiError("The assistant has no Anthropic key to use. Add your own in Settings. Answering the questions above still works.", 429)} />
      )}

      <div className="chat" aria-live="polite">
        {items.map((it, i) => <ChatRow key={i} it={it} onDone={(next) => { setItems(next); onChanged(); }} onFail={setFail} />)}
        {busy && live && <div className="bot">{live}</div>}
        {busy && !live && <div className="bot thinking">{status ?? "Thinking…"}</div>}
        {fail != null && <ErrorNote error={fail} />}
        <div ref={end} />
      </div>

      {data?.ai && items.length === 0 && !busy && (
        <div className="sugg">
          {STARTERS.map((s) => <button key={s} className="qchip" onClick={() => send(s)}>{s}</button>)}
        </div>
      )}

      {data?.ai && (
        <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder='Ask, or log "20 bakery cash"'
            aria-label="Message the assistant" enterKeyHint="send" />
          <button className="send" type="submit" aria-label="Send" disabled={busy || !text.trim()}><Icon icon="mdi:arrow-up" /></button>
        </form>
      )}
    </div>
  );
}

function ChatRow({ it, onDone, onFail }: { it: ChatItem; onDone: (items: ChatItem[]) => void; onFail: (e: unknown) => void }) {
  const [busy, setBusy] = useState(false);
  if (it.type !== "action") {
    if (it.type === "me") return <div className="me">{it.text}</div>;
    if (it.type === "bot") return <div className="bot">{it.text}</div>;
    return <div className="note-line">{it.text.replace(/^I confirmed: .*?Result: /, "").replace(/^I cancelled: /, "Cancelled: ")}</div>;
  }
  const pending = it.status === "pending";
  return (
    <div className={`action-card ${pending ? "" : "settled"}`}>
      <div className="action-sum"><Icon icon={it.status === "done" ? "mdi:check-circle-outline" : "mdi:pencil-outline"} />{it.summary}</div>
      {it.detail && <div className="muted small" style={{ marginTop: 2 }}>{it.detail}</div>}
      {pending ? (
        <div className="row-actions" style={{ marginTop: 8 }}>
          <button className="btn" disabled={busy} onClick={() => {
            setBusy(true);
            confirmAction(it.id).then((r) => onDone(r.items)).catch(onFail).finally(() => setBusy(false));
          }}>Do it</button>
          <button className="chip" disabled={busy} onClick={() => { setBusy(true); cancelAction(it.id).then((r) => onDone(r.items)).finally(() => setBusy(false)); }}>Cancel</button>
        </div>
      ) : (
        <div className="muted small" style={{ marginTop: 4 }}>{it.status === "done" ? "Done" : it.status === "cancelled" ? "Cancelled" : "Not confirmed"}</div>
      )}
    </div>
  );
}

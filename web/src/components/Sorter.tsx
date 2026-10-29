import { useEffect, useState } from "react";
import { answerQuestion, guessCategory, undoAnswer, useApi, type SortGuess, type SortItem } from "../lib/api";
import { euro } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { Card, Crumbs, Icon } from "./ui";

const SPENDING_ORDER = ["groceries", "eating_out", "delivery", "coffee_bars", "car", "shopping", "subscriptions", "bills", "housing",
  "loans", "insurance", "health", "personal_care", "travel", "leisure", "pets", "kids", "education", "gifts", "people", "cash", "fees", "other"];
const NOT_SPENDING = ["income", "transfer", "investments", "card_payment"];
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });

/** One payment at a time: what can be told about it, Assistant's guess with a reason, and one tap to
 * accept it. Answering moves every payment to that payee, now and later. */
export function Sorter({ byId, version, onChanged }: ScreenProps & { onChanged: () => void }) {
  const { data, error, reload } = useApi<{ items: SortItem[]; ai: boolean }>("/api/sorter", version);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [guesses, setGuesses] = useState<Record<string, SortGuess | "busy" | "failed">>({});
  const [sheet, setSheet] = useState(false);
  // What you picked in the sheet: it replaces the guess on the confirm button, and nothing is saved until you tap it.
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; service: string } | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  const left = (data?.items ?? []).filter((i) => !skipped.includes(i.service));
  const item = left[0];
  useEffect(() => { if (data && total == null) setTotal(data.items.length); }, [data, total]);
  useEffect(() => setChosen(null), [item?.service]);

  // Ask Claude for this payment's guess, and the next one's while you read.
  useEffect(() => {
    if (!data?.ai) return;
    for (const it of left.slice(0, 2)) {
      if (it.guess || guesses[it.service]) continue;
      setGuesses((g) => ({ ...g, [it.service]: "busy" }));
      guessCategory(it.service).then((r) => setGuesses((g) => ({ ...g, [it.service]: r })))
        .catch(() => setGuesses((g) => ({ ...g, [it.service]: "failed" })));
    }
  }, [data, item?.service]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);

  const pick = (category: string) => {
    if (!item) return;
    setBusy(true); setSheet(false);
    answerQuestion(item.service, category).then(() => {
      setToast({ text: `Saved ${item.service} as ${byId[category]?.label ?? category}. Future payments there too.`, service: item.service });
      reload(); onChanged();
    }).finally(() => setBusy(false));
  };
  const undo = () => {
    if (!toast) return;
    undoAnswer(toast.service).then(() => { setToast(null); reload(); onChanged(); });
  };
  const ask = () => {
    if (!item) return;
    try { sessionStorage.setItem("assistantDraft", `About the ${euro(item.amount)} payment to ${item.service} on ${DAY.format(new Date(`${item.date}T12:00:00`))}: what could it be?`); } catch { /* the chat just opens empty */ }
    location.hash = hrefFor({ page: "assistant" });
  };

  const done = (total ?? 0) - left.length;
  const g = item ? (item.guess ?? guesses[item.service]) : undefined;
  const guess = g && typeof g === "object" ? g : null;
  const answer = chosen ?? guess?.category ?? null;

  return (
    <>
      <Crumbs items={[{ label: "Assistant", href: hrefFor({ page: "assistant" }) }, { label: "Sort payments" }]} />
      <header className="hello top">
        <div><h1>Sort payments</h1></div>
        {item && total != null && <span className="muted small num">{Math.min(done + 1, total)} of {total}</span>}
      </header>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && total != null && total > 0 && (
        <div className="so-dots">{Array.from({ length: total }, (_, k) => <i key={k} className={k < done ? "done" : k === done ? "cur" : ""} />)}</div>
      )}
      {data && !item && (skipped.length === 0 ? (
        <Card><div className="so-done"><Icon icon="mdi:check" /><h2>All sorted</h2><p className="muted">Future payments to these places will go to the same categories.</p></div></Card>
      ) : (
        <Card><div className="so-done"><Icon icon="mdi:check" /><h2>Done for now</h2>
          <p className="muted">{skipped.length === 1 ? "You skipped one payment. It" : `You skipped ${skipped.length} payments. They`}'ll be here next time.</p>
          <button className="chip" onClick={() => setSkipped([])}><Icon icon="mdi:history" />Go back to {skipped.length === 1 ? "it" : "them"}</button></div></Card>
      ))}
      {item && (
        <Card>
          <div className="so-amt num">{euro(item.amount)}{item.count > 1 && <small> × {item.count}</small>}</div>
          <div className="so-who">{item.service}</div>
          <div className="so-meta">{DAY.format(new Date(`${item.date}T12:00:00`))}, {ago(item.days_ago)} · {item.how}</div>
          <div className="so-facts">
            {item.shop && <div className="so-fact"><Icon icon="mdi:storefront-outline" /><span>The bank lists it as <b>{item.shop}</b>.</span></div>}
            <div className="so-fact"><Icon icon="mdi:calendar-month-outline" />
              <span>{item.same_day.length ? <><b>That day you also paid</b>
                <span className="so-rows">{item.same_day.map((p, i) => <span key={i}><span>{p.name}</span><span className="num">{euro(p.amount)}</span></span>)}</span></>
                : <><b>Nothing else</b> was spent that day.</>}</span>
            </div>
            <div className="so-fact"><Icon icon="mdi:history" />
              <span>{item.history.length ? <>Paid before: {item.history.slice(0, 3).map((h) => `${euro(h.amount)} on ${DAY.format(new Date(`${h.date}T12:00:00`))}`).join(", ")}.</> : <>First payment to {item.service}.</>}</span>
            </div>
          </div>
          {data?.ai && (
            <div className="so-guess">
              <div className="so-gh"><Icon icon="mdi:creation-outline" />Assistant's guess</div>
              {guess ? <>
                  <p>{guess.reason}</p>
                  {guess.remembered?.map((r) => <p key={r} className="so-mem"><Icon icon="mdi:history" /><span>You told it: “{r}”</span></p>)}
                </>
                : g === "failed" ? <p className="muted">The assistant couldn't guess this one. Pick it below.</p>
                : <><div className="sp-skel" /><div className="sp-skel short" /></>}
            </div>
          )}
          {answer && (
            <div className="so-confirm">
              <button className="so-big" disabled={busy} onClick={() => pick(answer)}>
                <Icon icon={byId[answer]?.icon ?? "mdi:dots-horizontal"} />
                <span>{byId[answer]?.label ?? answer}</span>
                <span className="so-next">{busy ? "Saving…" : <>Save &amp; next<Icon icon="mdi:arrow-right" /></>}</span>
              </button>
              {chosen && guess && chosen !== guess.category && (
                <p className="muted small">Changed from {byId[guess.category]?.label ?? guess.category}.{" "}
                  <button className="link" onClick={() => setChosen(null)}>Use the guess</button></p>
              )}
            </div>
          )}
          <div className="so-row3">
            <button onClick={() => setSheet(true)} disabled={busy}><Icon icon="mdi:pencil-outline" />{answer ? "Change" : "Pick"}</button>
            {data?.ai && <button onClick={ask}><Icon icon="mdi:message-text-outline" />Ask</button>}
            <button onClick={() => setSkipped([...skipped, item.service])}><Icon icon="mdi:chevron-right" />Skip</button>
          </div>
        </Card>
      )}
      {sheet && item && (
        <div className="so-sheet-bg" onClick={() => setSheet(false)}>
          <div className="so-sheet" role="dialog" aria-label="What was it?" onClick={(e) => e.stopPropagation()}>
            <div className="so-sh"><span>What was it?<span className="muted small so-shh">Pick one, then Save &amp; next.</span></span><button className="chip icon-only" aria-label="Close" onClick={() => setSheet(false)}><Icon icon="mdi:close" /></button></div>
            <div className="so-grid">
              {SPENDING_ORDER.filter((c) => byId[c]).map((c) => (
                <button key={c} className={answer === c ? "sug" : ""} onClick={() => { setChosen(c); setSheet(false); }}><Icon icon={byId[c].icon} />{byId[c].label}</button>
              ))}
              <div className="so-sep">Not spending</div>
              {NOT_SPENDING.filter((c) => byId[c]).map((c) => (
                <button key={c} className={answer === c ? "sug" : ""} onClick={() => { setChosen(c); setSheet(false); }}><Icon icon={byId[c].icon} />{byId[c].label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
      {toast && <div className="so-toast" role="status"><Icon icon="mdi:check" /><span>{toast.text}</span><button onClick={undo}>Undo</button></div>}
    </>
  );
}

function ago(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

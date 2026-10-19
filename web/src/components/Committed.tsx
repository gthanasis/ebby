import { useState } from "react";
import { MonthlyChart } from "../charts/charts";
import { addCommitment, useApi, type Commitments, type CommitmentSuggestion } from "../lib/api";
import { euroRound, monthLabel } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { MonthNav } from "./Spending";
import { Card, CardHeader, Crumbs, Icon, Meter } from "./ui";

/** Committed: fixed and chosen costs. Limits only, no cutting advice. Drills into each one's payments. */
export function CommittedView({ version, go, month, onChanged }: ScreenProps & { month: string; onChanged: () => void }) {
  const { data, error, reload } = useApi<Commitments>(`/api/commitments?month=${month}`, version);
  const name = monthLabel(month).split(" ")[0];
  return (
    <>
      <Crumbs items={[{ label: "Spending", href: hrefFor({ page: "spending", month }) }, { label: "Committed" }]} />
      <header className="hello top">
        <div><h1>Committed</h1><p>Costs you've chosen. Only a warning past the limit.</p></div>
        <MonthNav month={month} go={go} />
      </header>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <div className="col">
          {data.items.length > 0 ? (
            <Card>
              <div className="left-label">Committed in {name}</div>
              <div className={`left-num num ${data.over.length ? "over" : ""}`}>{euroRound(data.spent)}</div>
              <Meter spent={data.spent} limit={data.limit} label="limits" />
              <div className="legend3 num">
                {data.over.length ? `${data.over.join(" and ")} past ${data.over.length === 1 ? "its limit" : "their limits"}.` : "All within their limits."}
              </div>
            </Card>
          ) : (
            <Card>
              <div className="empty" style={{ padding: "16px 8px" }}>
                <Icon icon="mdi:repeat" />
                <b>Nothing committed yet</b>
                <span>Mark the costs you've chosen, like a meal plan or a tool you invest in. They leave free spending and its advice, and only warn past their limit.</span>
              </div>
            </Card>
          )}

          {data.items.length > 0 && (
            <Card>
              {data.items.map((c) => (
                <a key={c.id} className="part" href={c.services.length ? hrefFor({ page: "transactions", commitment: c.id, month }) : hrefFor({ page: "settings", section: "fixed" })}>
                  <span className={`ricon ${c.over ? "warn" : ""}`}><Icon icon={c.kind === "fixed" ? "mdi:home-outline" : "mdi:repeat"} /></span>
                  <span className="t">
                    <b>{c.name}</b>
                    <span className="muted small num text-wrap">
                      {[c.note, c.off_bank ? `${euroRound(c.off_bank)} paid outside your accounts` : "", `limit ${euroRound(c.monthly_limit)}`].filter(Boolean).join(" · ")}
                    </span>
                    <span className="bar"><i className={c.over ? "over" : ""} style={{ width: `${Math.min(100, (c.spent / c.monthly_limit) * 100)}%` }} /></span>
                  </span>
                  <span className={`amt num ${c.over ? "over-txt" : ""}`}>{euroRound(c.spent)}<span>{c.over ? `+${euroRound(c.spent - c.monthly_limit)}` : `of ${euroRound(c.monthly_limit)}`}</span></span>
                  <Icon icon="mdi:chevron-right" />
                </a>
              ))}
            </Card>
          )}

          {data.items.length > 0 && (
            <Card>
              <CardHeader icon="mdi:calendar-month-outline" title="Last 6 months" />
              <MonthlyChart
                months={data.items[0].history.map((h, i) => ({ month: h.month, spent: data.items.reduce((s, c) => s + c.history[i].spent, 0) }))}
                selected={month} plan={data.limit} lineLabel="limits" height={130} onSelect={(m) => go({ month: m })} />
            </Card>
          )}

          {data.suggestions.length > 0 && (
            <Card>
              <CardHeader icon="mdi:repeat" title="Recurring, not committed yet" />
              {data.suggestions.slice(0, 6).map((s) => (
                <Suggestion key={s.service} s={s} onAdded={() => { reload(); onChanged(); }} />
              ))}
              <p className="hint">Only pick what you've decided to keep paying. Habits you want to cut belong in free spending.</p>
            </Card>
          )}

          <Card>
            <a className="part" href={hrefFor({ page: "settings", section: "fixed" })}>
              <span className="ricon"><Icon icon="mdi:cog-outline" /></span>
              <span className="t"><b>Manage commitments</b><span className="muted small">Limits, notes, rent paid outside your accounts</span></span>
              <Icon icon="mdi:chevron-right" />
            </a>
          </Card>
        </div>
      )}
    </>
  );
}

function Suggestion({ s, onAdded }: { s: CommitmentSuggestion; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="part">
      <span className="ricon"><Icon icon="mdi:repeat" /></span>
      <span className="t"><b>{s.service}</b><span className="muted small num">about {euroRound(s.monthly)} a month · limit {euroRound(s.limit)}</span>
        {error && <span className="error small">{error}</span>}</span>
      <button className="chip" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        addCommitment({ name: s.service, kind: "chosen", monthly_limit: s.limit, note: "", services: [s.service], off_bank: 0 })
          .then(onAdded).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
      }}><Icon icon="mdi:plus" />Commit</button>
    </div>
  );
}

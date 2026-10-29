import { useEffect, useState } from "react";
import { setCategory, useApi, type Category, type Commitments, type Transaction } from "../lib/api";
import { dayLabel, euro, euroRound, monthLabel, shortDay } from "../lib/format";
import { hrefFor, type Route } from "./App";
import { MonthNav } from "./Spending";
import { useOpenPayment } from "./PaymentSheet";
import { Card, Crumbs, Icon, Select } from "./ui";

interface Props {
  month: string; category?: string; service?: string; commitment?: number; categories: Category[]; byId: Record<string, Category>;
  version: number; onChanged: () => void; go: (r: Partial<Route>) => void;
}

const PAGE = 100;

/** The raw data. Also the last level of every Spending drill-down, opened with its filters applied. */
export function Transactions({ month, category, service, commitment, categories, byId, version, onChanged, go }: Props) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [toast, setToast] = useState<Moved | null>(null);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 8000); return () => clearTimeout(t); }, [toast]);
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  useEffect(() => setLimit(PAGE), [month, category, service, commitment, query]);

  // Searching looks across all months; browsing stays in the selected one.
  const params = new URLSearchParams({
    limit: String(limit), ...(query ? { q: query } : { month }),
    ...(category ? { category } : {}), ...(category && service ? { service } : {}),
    ...(commitment != null ? { commitment: String(commitment) } : {}),
  });
  const { data, error } = useApi<{ rows: Transaction[]; total: number; spent: number | null }>(`/api/transactions?${params}`, version);
  const committed = useApi<Commitments>(commitment != null ? `/api/commitments?month=${month}` : null, version);
  const commitmentName = committed.data?.items.find((c) => c.id === commitment)?.name ?? "Commitment";
  const catLabel = category ? byId[category]?.label ?? category : undefined;
  const drilled = !!category || commitment != null;
  const crumbs = commitment != null
    ? [{ label: "Spending", href: hrefFor({ page: "spending", month }) }, { label: "Committed", href: hrefFor({ page: "committed", month }) },
       { label: commitmentName }, { label: "Transactions" }]
    : [{ label: "Spending", href: hrefFor({ page: "spending", month }) },
       { label: catLabel ?? "", href: hrefFor({ page: "category", category, month }) },
       ...(service ? [{ label: service, href: hrefFor({ page: "service", category, service, month }) }] : []),
       { label: "Transactions" }];

  const days = new Map<string, Transaction[]>();
  for (const t of data?.rows ?? []) days.set(t.date, [...(days.get(t.date) ?? []), t]);

  return (
    <>
      {drilled ? <Crumbs items={crumbs} /> : <Crumbs items={[{ label: "Spending", href: hrefFor({ page: "spending" }) }, { label: "Search" }]} />}
      <header className="hello top">
        <div>
          <h1>{drilled ? "Payments" : "Search"}</h1>
          <p className="num">
            {query ? "All months" : monthLabel(month)}
            {data ? ` · ${data.total} ${data.total === 1 ? "payment" : "payments"}` : ""}
            {drilled && data?.spent ? ` · ${euroRound(data.spent)}` : ""}
          </p>
        </div>
        {!query && <MonthNav month={month} go={go} />}
      </header>
      <Card>
        <div className="toolbar">
          <label className="search">
            <Icon icon="mdi:magnify" />
            <input type="search" placeholder="Search all months, e.g. Wolt" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search transactions" />
          </label>
          {!drilled && (
            <Select value="" aria-label="Category" onChange={(e) => go({ category: e.target.value || undefined, service: undefined })}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          )}
        </div>
        {drilled && (
          <div>
            <a className="filterchip" href={hrefFor({ page: "transactions", month })} aria-label={`Clear filter ${service ?? catLabel ?? commitmentName}`}>
              {commitment != null ? commitmentName : service ?? catLabel}{query ? "" : ` · ${monthLabel(month).split(" ")[0]}`}<Icon icon="mdi:close" />
            </a>
            {service && (
              <a className="filterchip" href={hrefFor({ page: "transactions", month, category })} aria-label={`Show all of ${catLabel}`}>
                All {catLabel?.toLowerCase()}<Icon icon="mdi:chevron-right" />
              </a>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
        {data && data.rows.length === 0 && (
          <div className="empty"><Icon icon="mdi:format-list-bulleted" />{query ? `Nothing matches "${query}"` : "No transactions here"}</div>
        )}

        {[...days].map(([date, rows]) => {
          const net = rows.filter((r) => byId[r.category]?.spending).reduce((s, r) => s + r.amount, 0);
          return (
            <div key={date}>
              <div className="day-h"><span>{dayLabel(date)}</span>{net < 0 && <span className="num">{euro(-net)}</span>}</div>
              {rows.map((t) => <Row key={t.id} t={t} categories={categories} byId={byId} onChanged={onChanged} onMoved={setToast} />)}
            </div>
          );
        })}

        {data && data.total > data.rows.length && (
          <div className="more">
            <button className="chip" onClick={() => setLimit((l) => l + PAGE)}>Show more ({data.total - data.rows.length} left)</button>
          </div>
        )}
      </Card>
      {toast && <MovedToast moved={toast} byId={byId} onChanged={onChanged} onDone={() => setToast(null)} />}
    </>
  );
}

interface Moved { id: string; category: string; merchant: string; others: number }

/** After one payment moves: offers to move the payee's other payments too. */
function MovedToast({ moved, byId, onChanged, onDone }: { moved: Moved; byId: Record<string, Category>; onChanged: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const label = byId[moved.category]?.label ?? moved.category;
  const all = () => {
    setBusy(true);
    setCategory(moved.id, moved.category, true).then(() => { onChanged(); onDone(); }).finally(() => setBusy(false));
  };
  return (
    <div className="so-toast" role="status">
      <Icon icon="mdi:check" />
      <span>Only this payment moved. Move the other {moved.others} {moved.merchant} {moved.others === 1 ? "payment" : "payments"} to {label} too?</span>
      <button onClick={all} disabled={busy}>Move all</button>
    </div>
  );
}

function Row({ t, categories, byId, onChanged, onMoved }: {
  t: Transaction; categories: Category[]; byId: Record<string, Category>; onChanged: () => void; onMoved: (m: Moved | null) => void;
}) {
  const cat = byId[t.category];
  const [saving, setSaving] = useState(false);
  const title = t.merchant || (t.is_card ? `Card purchase · ${cat?.label ?? "Other"}` : t.description);
  const counted = cat?.spending ?? true;
  const open = useOpenPayment();
  return (
    <div className="part">
      <span className="ricon"><Icon icon={cat?.icon ?? "mdi:dots-horizontal"} /></span>
      <span className="t">
        <button className="tx-open" onClick={() => open(t.id)}>{title}<Icon icon="mdi:chevron-right" /></button>
        <span className="muted small">
          {t.commitment_id != null && <span className="tag-fixed"><Icon icon="mdi:repeat" />Fixed</span>}
          {t.commitment_id != null && " "}
          {t.account_name}
          {t.booked && <span> · booked {shortDay(t.booked)}</span>}
          {t.status === "PDNG" && <span className="pending"> · pending</span>}
        </span>
        <Select variant="sm" value={t.category} disabled={saving}
        aria-label={`Category for ${title}`}
        title="Changes this payment only"
        onChange={(e) => {
          const category = e.target.value;
          setSaving(true);
          setCategory(t.id, category).then((r) => {
            onMoved(r.merchant && r.others > 0 ? { id: t.id, category, merchant: r.merchant, others: r.others } : null);
            onChanged();
          }).finally(() => setSaving(false));
        }}
      >
        {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </Select>
      </span>
      <span className={`amt num ${t.amount > 0 ? "in" : ""} ${counted ? "" : "excluded"}`}>
        {t.amount > 0 ? "+" : ""}{euro(t.amount)}
      </span>
    </div>
  );
}

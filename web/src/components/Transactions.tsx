import { useEffect, useState } from "react";
import { useApi, type Category, type Commitments, type Transaction } from "../lib/api";
import { dayLabel, euro, euroRound, monthLabel, shortDay } from "../lib/format";
import { hrefFor, type Route } from "./App";
import { MonthNav } from "./Spending";
import { isNameable, useOpenPayment } from "./PaymentSheet";
import { Card, Crumbs, Icon, Select } from "./ui";

interface Props {
  month: string; category?: string; service?: string; commitment?: number; categories: Category[]; byId: Record<string, Category>;
  version: number; onChanged: () => void; go: (r: Partial<Route>) => void;
}

const PAGE = 100;

/** The raw data. Also the last level of every Spending drill-down, opened with its filters applied. */
export function Transactions({ month, category, service, commitment, categories, byId, version, go }: Props) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
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
              {rows.map((t) => <Row key={t.id} t={t} byId={byId} />)}
            </div>
          );
        })}

        {data && data.total > data.rows.length && (
          <div className="more">
            <button className="chip" onClick={() => setLimit((l) => l + PAGE)}>Show more ({data.total - data.rows.length} left)</button>
          </div>
        )}
      </Card>
    </>
  );
}

/** A payment as two quiet lines; tapping it opens its sheet, where its category, fixed cost and (for money sent to
 * people) who it went to can be changed. */
function Row({ t, byId }: { t: Transaction; byId: Record<string, Category> }) {
  const cat = byId[t.category];
  const title = t.merchant || (t.is_card ? `Card purchase · ${cat?.label ?? "Other"}` : t.description);
  const counted = cat?.spending ?? true;
  const open = useOpenPayment();
  return (
    <button type="button" className="part pay" onClick={() => open(t.id)} aria-label={`${title}, ${euro(t.amount)}: open payment`}>
      <span className="ricon"><Icon icon={cat?.icon ?? "mdi:dots-horizontal"} /></span>
      <span className="t">
        <b>{title}</b>
        <span className="muted small">
          {t.commitment_id != null && <span className="tag-fixed"><Icon icon="mdi:repeat" />Fixed</span>}
          {t.commitment_id != null && " "}
          {cat?.label ?? t.category}
          {isNameable(t) && t.description !== title && <> · {t.description}</>}
          {" · "}{t.account_name}
          {t.booked && <> · booked {shortDay(t.booked)}</>}
          {t.status === "PDNG" && <span className="pending"> · pending</span>}
        </span>
      </span>
      <span className={`amt num ${t.amount > 0 ? "in" : ""} ${counted ? "" : "excluded"}`}>
        {t.amount > 0 ? "+" : ""}{euro(t.amount)}
      </span>
    </button>
  );
}

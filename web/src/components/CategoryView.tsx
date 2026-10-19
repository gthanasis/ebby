import { useApi, type Range, type SpendCategory } from "../lib/api";
import { euroRound, monthLabel, thisMonth } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { Card, Crumbs, Icon } from "./ui";

const at = (d: string) => new Date(`${d}T12:00:00`);
const SHORT: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };

/** One category over the period picked in Spending: its total, its usual month, the last six months,
 * and who got the money. A service opens its own page; Spending's period carries through. */
export function CategoryView({ byId, version, range, off, category }: ScreenProps & { range: Range; off: number; category: string }) {
  const { data, error } = useApi<SpendCategory>(`/api/spending/category?category=${encodeURIComponent(category)}&range=${range}&off=${off}`, version);
  const cat = byId[category];
  const period = data ? periodName(data) : "";
  const top = data ? Math.max(data.usual_month, ...data.history.map((h) => h.total), 1) * 1.05 : 1;

  return (
    <>
      <Crumbs items={[{ label: "Spending", href: hrefFor({ page: "spending", range, off }) }, { label: cat?.label ?? category }]} />
      <header className="hello"><h1>{cat?.label ?? category}</h1>{data && <p>{period}</p>}</header>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <div className="col">
          <Card>
            <div className="sp-total num">{euroRound(data.total)}<small>{data.count} {data.count === 1 ? "payment" : "payments"}</small></div>
            <div className="sp-pair num">
              <div><span>Usual month</span><b>{euroRound(data.usual_month)}</b></div>
              <div><span>Average payment</span><b>{euroRound(data.count ? data.total / data.count : 0)}</b></div>
            </div>
            <div className="sp-chart">
              <div className="sp-bars" style={{ gridTemplateColumns: "repeat(6, 1fr)", height: 72 }}>
                {data.history.map((h) => (
                  <i key={h.key} className={h.key === data.month ? "cur" : ""} style={{ height: `${Math.max(2, (h.total / top) * 100)}%` }} title={euroRound(h.total)} />
                ))}
                <span className="sp-ref" style={{ bottom: `${(data.usual_month / top) * 100}%` }}><em className="num">usual {euroRound(data.usual_month)}</em></span>
              </div>
              <div className="sp-x" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
                {data.history.map((h) => <span key={h.key}>{monthLabel(h.key).slice(0, 3)}</span>)}
              </div>
            </div>
          </Card>
          <div className="group-label">Who got it</div>
          <Card className="list">
            {data.services.length === 0 && <div className="empty">Nothing in this period.</div>}
            {data.services.map((s) => (
              <a key={s.name} className="part" href={hrefFor({ page: "service", category, service: s.name, month: data.month })}>
                <span className="t"><b>{s.name}</b><span className="muted small num">{s.count} {s.count === 1 ? "payment" : "payments"} · {euroRound(s.spent / s.count)} on average</span></span>
                <span className="amt num">{euroRound(s.spent)}</span>
                <Icon icon="mdi:chevron-right" />
              </a>
            ))}
          </Card>
          <a className="btn ghost block" href={hrefFor({ page: "transactions", category, month: data.month })}><Icon icon="mdi:format-list-bulleted" />All {(cat?.label ?? category).toLowerCase()} payments</a>
        </div>
      )}
    </>
  );
}

function periodName(d: SpendCategory): string {
  if (d.range === "day") return at(d.start).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  if (d.range === "year") return d.key;
  const span = `${at(d.start).toLocaleDateString("en-GB", SHORT)} – ${at(d.end).toLocaleDateString("en-GB", SHORT)}`;
  if (d.range === "week") return `Week of ${span}`;
  return `${monthLabel(d.key).split(" ")[0]}${d.key.slice(0, 4) === thisMonth().slice(0, 4) ? "" : ` ${d.key.slice(0, 4)}`} · ${span}`;
}

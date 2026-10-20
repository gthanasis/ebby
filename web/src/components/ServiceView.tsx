import { MonthlyChart } from "../charts/charts";
import { moveService, useApi, type Category, type ServiceDetail } from "../lib/api";
import { useAction } from "../lib/action";
import { euro, euroRound, monthLabel } from "../lib/format";
import { hrefFor, type ScreenProps } from "./App";
import { MonthNav } from "./Spending";
import { Card, CardHeader, Crumbs, Icon, Select } from "./ui";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_LONG = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric" });
const dayOf = (d: string) => DAY.format(new Date(`${d}T12:00:00`));

/** Service level: one payee inside one category. The next level down is the raw transactions. */
export function ServiceView({ byId, version, go, month, category, service }: ScreenProps & { month: string; category: string; service: string }) {
  const q = new URLSearchParams({ category, name: service, month });
  const { data, error } = useApi<ServiceDetail>(`/api/service?${q}`, version);
  const cat = byId[category];
  const name = monthLabel(month).split(" ")[0];
  const top = Math.max(1, ...(data?.weekdays ?? [0]));
  const peak = data ? data.weekdays.indexOf(Math.max(...data.weekdays)) : -1;
  const peakShare = data && data.spent > 0 ? data.weekdays[peak] / data.spent : 0;

  return (
    <>
      <Crumbs items={[
        { label: "Spending", href: hrefFor({ page: "spending", month }) },
        { label: cat?.label ?? category, href: hrefFor({ page: "category", category, month }) },
        { label: service },
      ]} />
      <header className="hello top">
        <div>
          <h1>{service}</h1>
          <p className="num">
            {monthLabel(month)}
            {data && data.count ? ` · ${data.count} ${data.count === 1 ? "payment" : "payments"}` : ""}
            {data && data.count > 1 ? ` · ${euroRound(data.average)} on average` : ""}
          </p>
        </div>
        <MonthNav month={month} go={go} />
      </header>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <div className="col">
          <Card>
            <div className="left-label">{service} in {name}</div>
            <div className="left-num num">{euroRound(data.spent)}</div>
            {data.share != null && data.share < 1 && (
              <div className="legend3 num" style={{ marginTop: 6 }}>{Math.round(data.share * 100)}% of your {(cat?.label ?? category).toLowerCase()} spending.</div>
            )}
            <div className="chart-block">
              <div className="chart-title"><span>Last 6 months</span></div>
              <MonthlyChart months={data.history} selected={month} height={130} onSelect={(m) => go({ month: m })} />
            </div>
          </Card>

          {data.count >= 3 && (
            <Card>
              <CardHeader icon="mdi:calendar-month-outline" title="When you spend" />
              <div className="wd" role="img" aria-label={`Spending by weekday, most on ${WEEKDAYS[peak]}`}>
                {data.weekdays.map((v, i) => (
                  <div key={i} className="c" title={euro(v)}>
                    <i className={i === peak && peakShare >= 0.4 ? "hot" : ""} style={{ height: `${(v / top) * 100}%` }} />
                    <span>{WEEKDAYS[i]}</span>
                  </div>
                ))}
              </div>
              <p className="hint num">
                {peakShare >= 0.4 ? `${WEEKDAYS_LONG[peak]}: ${euroRound(data.weekdays[peak])} of ${euroRound(data.spent)}.` : "Spread across the week."}
                {data.busiest_days.length > 0 && ` On ${data.busiest_days.map((d) => dayOf(d.date)).join(" and ")} ${name} you paid ${data.busiest_days.map((d) => d.count).join(" and ")} times in a day.`}
              </p>
            </Card>
          )}

          <Card>
            <a className="part" href={hrefFor({ page: "transactions", category, service, month })}>
              <span className="ricon"><Icon icon="mdi:format-list-bulleted" /></span>
              <span className="t"><b>{data.count === 1 ? "The payment" : `All ${data.count} payments`}</b><span className="muted small">Open in Transactions</span></span>
              <Icon icon="mdi:chevron-right" />
            </a>
            <MoveService category={category} service={service} byId={byId} onMoved={(to) => go({ page: "category", category: to, service: undefined })} />
          </Card>
        </div>
      )}
    </>
  );
}

function MoveService({ category, service, byId, onMoved }: {
  category: string; service: string; byId: Record<string, Category>; onMoved: (to: string) => void;
}) {
  const { busy, error, run } = useAction();
  return (
    <div className="part move">
      <span className="t"><b>Wrong category?</b><span className="muted small">Moves every {service} payment, now and later</span></span>
      <Select variant="chip" aria-label={`Move ${service} to another category`} value="" disabled={busy}
        onChange={(e) => {
          const to = e.target.value;
          if (!to) return;
          run(() => moveService(category, service, to).then(() => onMoved(to)));
        }}>
        <option value="">Move to…</option>
        {Object.values(byId).filter((c) => c.id !== category).map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </Select>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

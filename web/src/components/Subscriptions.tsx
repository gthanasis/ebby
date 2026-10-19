import { useApi, type Subscriptions } from "../lib/api";
import { euro, euroRound, thisMonth } from "../lib/format";
import type { ScreenProps } from "./App";
import { SpendingTabs } from "./Spending";
import { Card, Icon } from "./ui";

const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const short = (d: string) => DAY.format(new Date(`${d}T12:00:00`));

export function SubscriptionsScreen({ version }: ScreenProps) {
  const { data, error } = useApi<Subscriptions>("/api/subscriptions", version);
  return (
    <>
      <header className="hello">
        <h1>Subscriptions</h1>
        <p className="num">{data ? `${data.count} services · ${euroRound(data.monthly)} a month · ${euroRound(data.yearly)} a year` : "Loading…"}</p>
      </header>
      <SpendingTabs current="subscriptions" month={thisMonth()} />
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="skeleton" />}
      {data && (
        <>
          <Card>
            {data.items.length === 0 && <div className="chart-empty">No recurring charges found yet</div>}
            {data.items.map((s) => (
              <div key={s.name} className="part">
                <span className={`ricon ${s.stale ? "warn" : ""}`}><Icon icon={s.stale ? "mdi:alert-circle-outline" : "mdi:repeat"} /></span>
                <span className="t">
                  <b>{s.name}</b>
                  {s.stale
                    ? <span className="small over-txt text-wrap">No charge since {short(s.last_charge)} · cancelled?</span>
                    : <span className="muted small text-wrap">Monthly · {s.varies ? "amount varies" : s.next_charge ? `next around ${short(s.next_charge)}` : ""}</span>}
                </span>
                <span className={`amt num ${s.stale ? "muted" : ""}`}>{euro(s.monthly)}<span>/month</span></span>
              </div>
            ))}
          </Card>
          <p className="hint">
            Services charged in at least 3 of the last 6 months. Card charges from Alpha arrive without a merchant name, so they
            can't be told apart here; you'll find them as "Card · software" in Subscriptions &amp; tech.
          </p>
        </>
      )}
    </>
  );
}

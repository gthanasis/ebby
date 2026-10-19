import { useState } from "react";
import { dayLabel, euro, euroRound, monthLabel, monthShort } from "../lib/format";

interface Bar { key: string; label: string; value: number; highlight: boolean; title: string; over?: boolean }

/** Plain SVG bar chart: the accent for the highlighted bar, a soft tint for the rest. */
function Bars({ bars, height, ariaLabel, onSelect, line }: {
  bars: Bar[]; height: number; ariaLabel: string; onSelect?: (key: string) => void; line?: { value: number; label: string };
}) {
  const [hover, setHover] = useState<string | null>(null);
  const max = Math.max(1, line?.value ?? 0, ...bars.map((b) => b.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plot = height - 18;
  const width = 100 / bars.length;
  const shown = bars.find((b) => b.key === hover);
  return (
    <div className="bars">
      <div className="bars-plot" style={{ height: plot }}>
        {line && (
          <span className="bars-planline" style={{ bottom: `${(line.value / top) * 100}%` }}><em>{line.label}</em></span>
        )}
        {[top, top / 2].map((v) => (
          <span key={v} className="bars-line" style={{ bottom: `${(v / top) * 100}%` }}><i>{euroRound(v)}</i></span>
        ))}
        <svg width="100%" height={plot} role="img" aria-label={ariaLabel} preserveAspectRatio="none" viewBox={`0 0 100 ${plot}`}>
          {bars.map((b, i) => {
            const h = (b.value / top) * plot;
            return (
              <rect
                key={b.key}
                x={i * width + width * 0.15} width={width * 0.7} y={plot - h} height={Math.max(h, b.value > 0 ? 1 : 0)}
                className={`chart-bar${b.highlight ? " hi" : ""}${b.over && !b.highlight ? " ahead-col" : ""}${hover === b.key ? " hover" : ""}${onSelect ? " clickable" : ""}`}
                onMouseEnter={() => setHover(b.key)} onMouseLeave={() => setHover(null)}
                onClick={() => onSelect?.(b.key)}
              >
                <title>{b.title}</title>
              </rect>
            );
          })}
        </svg>
      </div>
      <div className="bars-x">
        {bars.map((b) => <span key={b.key} style={{ width: `${width}%` }}>{b.label}</span>)}
      </div>
      <div className="bars-tip" aria-live="polite">{shown ? shown.title : " "}</div>
    </div>
  );
}

function niceStep(max: number) {
  const raw = max / 2;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
}

/** Spending per day of the selected month; today is highlighted. */
export function DailyChart({ month, days }: { month: string; days: { date: string; amount: number }[] }) {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(y, m, 0).getDate();
  const byDate = new Map(days.map((d) => [d.date, d.amount]));
  const today = new Date().toISOString().slice(0, 10);
  const bars = Array.from({ length: count }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    const value = Math.max(0, byDate.get(date) ?? 0);
    const n = i + 1;
    return { key: date, label: n === 1 || n % 5 === 0 ? String(n) : "", value, highlight: date === today, title: `${dayLabel(date)} · ${euro(value)}` };
  });
  return <Bars bars={bars} height={150} ariaLabel={`Spending per day, ${monthLabel(month)}`} />;
}

/** Twelve months of spending; the selected month is highlighted and a bar click selects it. */
export function MonthlyChart({ months, selected, onSelect, plan, height = 170, lineLabel = "plan" }: {
  months: { month: string; spent: number }[]; selected: string; onSelect?: (month: string) => void;
  plan?: number | null; height?: number; lineLabel?: string;
}) {
  const bars = months.map((m) => ({
    key: m.month, label: monthShort(m.month), value: Math.max(0, m.spent), highlight: m.month === selected,
    over: plan != null && m.spent > plan, title: `${monthLabel(m.month)} · ${euro(m.spent)}`,
  }));
  return <Bars bars={bars} height={height} ariaLabel="Spending per month" onSelect={onSelect}
    line={plan ? { value: plan, label: `${lineLabel} ${euroRound(plan)}` } : undefined} />;
}

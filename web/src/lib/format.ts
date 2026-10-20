const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const EUR_ROUND = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

export const euro = (v: number | null | undefined) => (v == null ? "–" : EUR.format(v));
export const euroRound = (v: number | null | undefined) => (v == null ? "–" : EUR_ROUND.format(v));

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const MONTH_SHORT = new Intl.DateTimeFormat("en-GB", { month: "short" });
const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });
const DAY_SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

const monthDate = (m: string) => new Date(`${m}-01T12:00:00`);
export const monthLabel = (m: string) => MONTH.format(monthDate(m));
export const monthShort = (m: string) => MONTH_SHORT.format(monthDate(m));
export const dayLabel = (d: string) => DAY.format(new Date(`${d}T12:00:00`));
export const shortDay = (d: string) => DAY_SHORT.format(new Date(`${d}T12:00:00`));

export function shiftMonth(m: string, delta: number): string {
  const [y, mo] = m.split("-").map(Number);
  const i = y * 12 + (mo - 1) + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

// The pay month today is in comes from the server (payday decides it); until it answers, the
// last one seen, then the calendar month.
let current: string | null = (() => { try { return localStorage.getItem("payMonth"); } catch { return null; } })();
export const thisMonth = () => current ?? new Date().toISOString().slice(0, 7);
export function setThisMonth(m: string) {
  current = m;
  try { localStorage.setItem("payMonth", m); } catch { /* private mode: keep it in memory */ }
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export const daysUntil = (iso: string | null | undefined) =>
  iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400000) : null;

/** 1st, 2nd, 3rd, 25th: a day of the month. */
export const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

const SHORT_DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
/** A pay month's days, e.g. "25 Sep – 22 Oct" (end is the next month's first day). */
export function payRange(start: string, end: string): string {
  const last = new Date(`${end}T12:00:00`);
  last.setDate(last.getDate() - 1);
  return `${SHORT_DAY.format(new Date(`${start}T12:00:00`))} – ${SHORT_DAY.format(last)}`;
}

/**
 * Reads a typed euro amount. Accepts "4300", "4,300", "4.300", "1.234,56" and "12,50": a separator followed by
 * exactly three digits is a thousands separator, one or two digits after the last separator are cents.
 */
export function parseAmount(s: string): number {
  const t = s.replace(/[^\d.,]/g, "");
  const last = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  if (last < 0) return Number(t) || 0;
  const tail = t.slice(last + 1);
  const whole = t.slice(0, last).replace(/[.,]/g, "");
  return (tail.length === 3 ? Number(whole + tail) : Number(`${whole}.${tail}`)) || 0;
}

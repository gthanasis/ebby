/**
 * Python's arithmetic, formatting and dates, exactly, where ebby's numbers or ids depend on them. The API was
 * written in Python first; these keep every total, rounding and stored id the same.
 */

// ---------- numbers ----------

/** The exact decimal value of a double, as Python's round() sees it: "-12.3450000000000006394…". */
function exactDecimal(x: number): { neg: boolean; int: string; frac: string } {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0), lo = buf.getUint32(4);
  const neg = hi >>> 31 === 1;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (exp === 0) e = -1074;  // subnormal
  else { mant |= 1n << 52n; e = exp - 1075; }
  if (e >= 0) return { neg, int: (mant << BigInt(e)).toString(), frac: "" };
  const digits = (mant * 5n ** BigInt(-e)).toString().padStart(-e + 1, "0");
  return { neg, int: digits.slice(0, digits.length + e), frac: digits.slice(digits.length + e) };
}

/** Python's round(x, ndigits): the exact value rounded to ndigits decimals, an exact half going to even. */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const { neg, int, frac } = exactDecimal(x);
  if (ndigits < 0) return Math.round(x / 10 ** -ndigits) * 10 ** -ndigits;
  const kept = frac.slice(0, ndigits).padEnd(ndigits, "0");
  const rest = frac.slice(ndigits);
  let n = BigInt(int + kept);
  if (rest.length) {
    const first = rest.charCodeAt(0) - 48;
    const tail = /[1-9]/.test(rest.slice(1));
    if (first > 5 || (first === 5 && (tail || n % 2n === 1n))) n += 1n;
  }
  const s = n.toString().padStart(ndigits + 1, "0");
  const value = Number(ndigits ? `${s.slice(0, s.length - ndigits)}.${s.slice(s.length - ndigits)}` : s);
  return neg ? -value : value;
}

/** Python's a // b. */
export const floorDiv = (a: number, b: number) => Math.floor(a / b);
/** Python's a % b: the sign of b. */
export const pyMod = (a: number, b: number) => ((a % b) + b) % b;

export const sum = (xs: Iterable<number>) => { let t = 0; for (const x of xs) t += x; return t; };

/** Python's statistics.median. */
export function median(xs: number[]): number {
  if (!xs.length) throw new Error("median of no data");
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Python's max/min with key and default. */
export function maxBy<T>(xs: Iterable<T>, key: (x: T) => number | string | (number | string)[]): T | undefined {
  let best: T | undefined, bestKey: ReturnType<typeof key> | undefined;
  for (const x of xs) {
    const k = key(x);
    if (bestKey === undefined || cmp(k, bestKey) > 0) { best = x; bestKey = k; }
  }
  return best;
}
export function minBy<T>(xs: Iterable<T>, key: (x: T) => number | string | (number | string)[]): T | undefined {
  let best: T | undefined, bestKey: ReturnType<typeof key> | undefined;
  for (const x of xs) {
    const k = key(x);
    if (bestKey === undefined || cmp(k, bestKey) < 0) { best = x; bestKey = k; }
  }
  return best;
}

type Key = number | string | boolean | null | undefined | Key[];

/** Python's comparison of numbers, strings, and tuples of them. */
export function cmp(a: Key, b: Key): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = cmp(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;  // code points, like Python
  const x = Number(a), y = Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Python's sorted(xs, key=..., reverse=...): stable, compared like Python. */
export function sorted<T>(xs: Iterable<T>, key: (x: T) => Key = (x) => x as Key, reverse = false): T[] {
  const items = [...xs].map((x, i) => ({ x, k: key(x), i }));
  items.sort((p, q) => (reverse ? cmp(q.k, p.k) : cmp(p.k, q.k)) || p.i - q.i);
  return items.map((p) => p.x);
}

// ---------- json ----------

function pyFloat(x: number): string {
  if (Number.isInteger(x)) return Math.abs(x) < 1e16 ? `${x}.0` : String(x).replace(/e\+?/, "e+");
  const s = String(x);  // JS and Python both print the shortest repr that round-trips
  return s.replace(/e([+-])(\d)$/, "e$10$2").replace(/e\+?(\d)/, "e+$1");
}

function pyString(s: string, asciiOnly: boolean): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20 || (asciiOnly && c > 0x7e)) {
      if (c > 0xffff) {
        const v = c - 0x10000;
        out += `\\u${(0xd800 + (v >> 10)).toString(16).padStart(4, "0")}\\u${(0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0")}`;
      } else out += `\\u${c.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return out + '"';
}

/**
 * Python's json.dumps: ", " and ": " separators, non-ASCII escaped unless ensureAscii is false, floats as
 * Python writes them. Numbers that are whole in JS are written as ints unless listed in `floats`. Stored ids
 * are built from this (ingest.txKey), so it must match byte for byte.
 */
export function pyDumps(value: unknown, opts: { sortKeys?: boolean; ensureAscii?: boolean } = {}): string {
  const { sortKeys = false, ensureAscii = true } = opts;
  const go = (v: unknown): string => {
    if (v === null || v === undefined) return "null";
    if (v === true) return "true";
    if (v === false) return "false";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : pyFloat(v);
    if (v instanceof PyFloat) return pyFloat(v.value);
    if (typeof v === "string") return pyString(v, ensureAscii);
    if (Array.isArray(v)) return `[${v.map(go).join(", ")}]`;
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
    if (sortKeys) entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${pyString(k, ensureAscii)}: ${go(x)}`).join(", ")}}`;
  };
  return go(value);
}

/** A number Python held as a float even when it's whole (pyDumps writes it as 3.0, not 3). */
export class PyFloat { constructor(readonly value: number) {} valueOf() { return this.value; } }

// ---------- dates ----------

const DAY_MS = 86_400_000;

/** Python's datetime.date: a calendar day, compared and shifted by whole days. */
export class PyDate {
  /** Days since 1970-01-01. */
  readonly n: number;
  constructor(year: number, month: number, day: number) {
    if (month < 1 || month > 12 || day < 1 || day > monthDays(year, month)) throw new Error(`day is out of range for month: ${year}-${month}-${day}`);
    this.n = Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
  }
  static ofDays(n: number): PyDate {
    const d = new Date(n * DAY_MS);
    return new PyDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  static fromisoformat(s: string): PyDate {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) throw new Error(`Invalid isoformat string: '${s}'`);
    return new PyDate(+m[1], +m[2], +m[3]);
  }
  private get parts() { return new Date(this.n * DAY_MS); }
  get year() { return this.parts.getUTCFullYear(); }
  get month() { return this.parts.getUTCMonth() + 1; }
  get day() { return this.parts.getUTCDate(); }
  /** Monday is 0, like Python. */
  weekday() { return pyMod(this.n + 3, 7); }
  isoweekday() { return this.weekday() + 1; }
  /** ISO year and week, like date.isocalendar()[:2]. */
  isocalendar(): [number, number, number] {
    const thursday = this.addDays(3 - this.weekday());
    const jan1 = new PyDate(thursday.year, 1, 1);
    return [thursday.year, floorDiv(thursday.n - jan1.n, 7) + 1, this.isoweekday()];
  }
  addDays(days: number) { return PyDate.ofDays(this.n + days); }
  /** (this - other).days */
  diffDays(other: PyDate) { return this.n - other.n; }
  isoformat() {
    return `${String(this.year).padStart(4, "0")}-${String(this.month).padStart(2, "0")}-${String(this.day).padStart(2, "0")}`;
  }
  replace(p: { year?: number; month?: number; day?: number }) { return new PyDate(p.year ?? this.year, p.month ?? this.month, p.day ?? this.day); }
  toString() { return this.isoformat(); }
  toJSON() { return this.isoformat(); }
  valueOf() { return this.n; }
}

/** calendar.monthrange(y, m)[1] */
export function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Python's datetime.isoformat() for a UTC instant: 2026-10-20T06:00:00+00:00, microseconds when there are any. */
export function isoUtc(d: Date, timespec: "auto" | "seconds" = "auto"): string {
  const s = d.toISOString();  // 2026-10-20T06:00:00.123Z
  const ms = d.getUTCMilliseconds();
  const base = s.slice(0, 19);
  return timespec === "seconds" || !ms ? `${base}+00:00` : `${base}.${String(ms).padStart(3, "0")}000+00:00`;
}

/** Python's datetime.fromisoformat for the timestamps ebby stores. */
export function parseIso(s: string): Date {
  const d = new Date(s.replace(/(\.\d{3})\d+/, "$1"));
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid isoformat string: '${s}'`);
  return d;
}

// ---------- formatting ----------

/** Python's f"{x:,.0f}": rounded half to even, thousands separated by commas. */
export function fmt0(x: number, thousands = true): string {
  const r = pyRound(x);
  const s = Math.abs(r).toFixed(0);
  const grouped = thousands ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : s;
  return (r < 0 || Object.is(r, -0) ? "-" : "") + grouped;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** strftime("%B") */
export const monthName = (d: PyDate) => MONTHS[d.month - 1];

/** Python's f"{x:g}": six significant digits, trailing zeros dropped, exponent outside 1e-4..1e6. */
export function fmtG(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = Math.floor(Math.log10(Math.abs(Number(x.toPrecision(6)))));
  if (exp < -4 || exp >= 6) {
    const [m, e] = x.toExponential(5).split("e");
    const mant = m.includes(".") ? m.replace(/0+$/, "").replace(/\.$/, "") : m;
    const n = parseInt(e, 10);
    return `${mant}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }
  const s = x.toFixed(Math.max(0, 5 - exp));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Python's f"{x:.2f}" */
export const fmt2 = (x: number) => pyRound(x, 2).toFixed(2);

/** Python's f"{x:,.2f}" */
export function fmt2c(x: number): string {
  const [i, f] = fmt2(Math.abs(x)).split(".");
  return (x < 0 ? "-" : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + f;
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** strftime("%-d %b") and, with the year, "%-d %b %Y" */
export const dayMonth = (d: PyDate, withYear = false) => `${d.day} ${SHORT_MONTHS[d.month - 1]}${withYear ? ` ${d.year}` : ""}`;

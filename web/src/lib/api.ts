import { useCallback, useEffect, useRef, useState } from "react";
import type { Cut, Goal, GoalsOverview } from "./api.gen";
export type { Cut, Goal, GoalsOverview };

export interface Category { id: string; label: string; icon: string; spending: boolean }
export interface Account {
  id: string; bank: string; name: string; is_card: number; last4: string | null; balance: number | null;
  balance_at: string | null; synced_at: string | null; transactions: number; since: string | null;
}
export interface SyncError { at: string; code: string; message: string; reconnect: boolean }
export interface Connection { bank: string; connected: boolean; valid_until: string | null; last_sync: string | null; last_error: SyncError | null }
export interface Status {
  connections: Connection[]; last_sync: string | null; syncing: boolean; sync_hours: number; accounts: Account[];
  callback_in_app: boolean; questions: number; month: string;
}
export interface Overview {
  month: string; current: boolean; total: number; count: number; income: number;
  prev_month: string; prev_total: number; prev_to_date: number; oldest_month: string | null;
  by_category: { category: string; amount: number; count: number }[];
  daily: { date: string; amount: number }[];
  monthly: { month: string; spent: number; income: number }[];
  merchants: { merchant: string; category: string; amount: number; count: number }[];
}
export interface Transaction {
  id: string; date: string; amount: number; currency: string; status: string; description: string;
  merchant: string; mcc: string | null; category: string; account_name: string; is_card: number;
}

/** An API error: `message` is the server's ready-to-show `detail`, `status` its HTTP status (429: AI allowance used up). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
/** Over the AI allowance, or no key to use: worth a pointer to Settings → AI rather than a plain error. */
export const isAllowanceError = (e: unknown) =>
  e instanceof ApiError ? e.status === 429 : typeof e === "string" && /AI allowance|Anthropic key/i.test(e);

/** The response, once it's known to be a success: a 401 goes to sign-in, any failure throws its `detail`. */
async function send(path: string, init?: RequestInit): Promise<Response> {
  // A FormData body sets its own multipart Content-Type, boundary included.
  const headers = init?.body instanceof FormData ? init.headers : { "Content-Type": "application/json", ...init?.headers };
  const r = await fetch(path, { ...init, headers });
  if (r.status === 401 && !location.hash.startsWith("#/login")) location.hash = "#/login";
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new ApiError(body.detail ?? `Request failed (${r.status})`, r.status);
  }
  return r;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await send(path, init);
  return r.status === 204 ? (undefined as T) : r.json();
}

/** Loads `path`, keeping the previous data on screen while a new path loads. `version` forces a reload. */
export function useApi<T>(path: string | null, version = 0) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const current = useRef(path);
  current.current = path;

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    request<T>(path)
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, version, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Moves one payment, or with allFromMerchant every payment to its payee. `others`: payments to the payee still elsewhere. */
export const setCategory = (id: string, category: string, allFromMerchant = false) =>
  request<{ rule: string; merchant: string | null; others: number }>(`/api/transactions/${encodeURIComponent(id)}/category`,
    { method: "PUT", body: JSON.stringify({ category, all_from_merchant: allFromMerchant }) });
export const startSync = () => request<{ started: boolean }>("/api/sync", { method: "POST" });
/** A bank Enable Banking connects; consent_days is the longest access it allows. */
export interface Bank { name: string; logo: string | null; beta: boolean; consent_days: number | null }
export interface BankList { country: string; banks: Bank[] }
export const startAuth = (bank: string) => request<{ url: string }>("/api/auth/start", { method: "POST", body: JSON.stringify({ bank }) });
export const completeAuth = (address: string) =>
  request<{ bank: string; accounts: number }>("/api/auth/complete", { method: "POST", body: JSON.stringify({ address }) });

// ---------- redesign ----------

export interface PaceCategory {
  category: string; spent: number; count: number; budget: number | null;
  status: "over" | "ahead" | "fine" | "none"; habit: string;
}
export interface Pace {
  month: string; start: string; end: string; elapsed: number; days: number; total: number; planned: number | null;
  expected_to_date: number | null; projected: number; take_home: number | null; categories: PaceCategory[];
}
export interface Finding { title: string; detail: string; amount: number; unit: "month" | "week" | string; category: string }
export interface WeeklyRead {
  headline: string; body: string; findings?: Finding[]; actions: { text: string; saves_monthly: number }[];
  created_at: string; model: string; plan_changed?: boolean;
}
export interface Periods {
  today: string;
  day: { spent: number; limit: number; mode: "share" | "catch_up"; days_left: number; left_for_month: number; pace: number | null; finish: number };
  week: { spent: number; limit: number; daily_limit: number; start: string; days: { date: string; spent: number | null }[] };
  month: { key: string; spent: number; limit: number; goal: number; days_left: number; daily_limit: number; days: { date: string; spent: number | null }[] };
  /** A working limit to step down with: for next month while catching up, or for this one early on after a bad month. */
  suggest_limit: { month: string; limit: number; goal: number; last?: number } | null;
}
/** payday: a day 1-28 (1 = calendar months) or "last" for the last working day. */
export type Payday = number | "last";
export interface Settings {
  alerts: boolean; weekly_read: boolean; payday?: Payday; payday_dismissed?: boolean;
  /** Set when the plan was filled in from the first import; the banner shows until dismissed. */
  autofilled?: boolean; autofill_dismissed?: boolean;
  /** Which model answers in the Assistant tab and guesses categories in the sorter. */
  assistant_model?: AssistantModel;
  /** 14 salaries a year: Easter, summer and Christmas bonuses on top of the monthly pay. */
  extra_pay?: boolean;
  /** Your names as banks print them, to spot transfers between your own accounts. */
  owner_names?: string[];
  /** The banks you connect, as Enable Banking names them. */
  banks?: string[];
}
export type AssistantModel = "haiku" | "sonnet" | "opus";
/** When pay seems to arrive, read from the deposits. */
export interface PaydayGuess { day: number; amount: number; last: string; months: number }
/** This pay month so far. days covers the whole month; spent is null for days still to come. */
export interface TodayMonth {
  month: string; start: string; end: string; today: string; length: number; elapsed: number;
  spent: number; average: number; projected: number;
  days: { date: string; spent: number | null }[];
  categories: { category: string; spent: number; count: number }[];
  /** The budget this month should keep to; null without a plan. */
  ideal: Ideal | null;
}
export interface Ideal {
  income: number; savings: number; fixed: number; budget: number; day: number;
  goals: { name: string; price: number; target_date: string; monthly: number }[];
  targets: Record<string, number>;
}
export interface Home { month: TodayMonth; fresh_at: string | null; payday_hint: PaydayGuess | null }
export interface CategoryDetail {
  category: string; month: string; budget: number | null; spent: number;
  history: { month: string; spent: number }[];
  services: { name: string; amount: number; count: number; accounts: string[] }[];
}
export interface Subscription { name: string; monthly: number; months: number; last_charge: string; next_charge: string | null; varies: boolean; stale: boolean }
export interface Subscriptions { items: Subscription[]; monthly: number; yearly: number; count: number }
export interface Year {
  year: number; total: number; monthly_average: number; monthly_plan: number | null;
  months: { month: string; spent: number }[]; categories: { category: string; spent: number; count: number }[];
  peak: { month: string; spent: number } | null; peak_category: { category: string; spent: number } | null;
  under_plan: string[]; years: string[];
}
export interface Plan {
  take_home: number; keep: number; budgets: Record<string, number>; limits?: Record<string, number>;
  /** "auto" follows income, savings and fixed costs; "custom" keeps typed amounts. */
  split?: "auto" | "custom";
}
export interface PlanView {
  plan: Plan | null; averages: Record<string, number>; total?: number; committed: number; settings: Settings; devices: number; ai: boolean;
  payday_detected: PaydayGuess | null;
  /** The next bonuses when 14 salaries is on, soonest first. */
  extra_pay: ExtraPay[];
}
export interface ExtraPay { name: string; amount: number; date: string; when: string }

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const suggestPlan = (take_home: number, keep: number) =>
  request<{ budgets: Record<string, number>; averages: Record<string, number> }>("/api/plan/suggest", json("POST", { take_home, keep }));
export const savePlan = (p: Plan) => request<Plan>("/api/plan", json("PUT", p));
export const saveSettings = (s: Partial<Settings>) => request<Settings>("/api/settings", json("PUT", s));
export const setMonthLimit = (month: string, limit: number) => request<Plan>("/api/plan/limit", json("PUT", { month, limit }));
export const addGoal = (g: { name: string; price: number; target_date: string; saved?: number; kind?: "buy" | "save" }) => request<Goal[]>("/api/goals", json("POST", g));
export const patchGoal = (id: number, g: Partial<{ name: string; price: number; target_date: string; saved: number; add: number }>) =>
  request<Goal[]>(`/api/goals/${id}`, json("PATCH", g));
export const deleteGoal = (id: number) => request<Goal[]>(`/api/goals/${id}`, json("DELETE"));
export const refreshInsights = () => request<WeeklyRead>("/api/insights/refresh", json("POST"));
export const testPush = () => request<{ sent: number }>("/api/push/test", json("POST"));
export const liveSync = () => request<{ started: boolean; reason?: string }>("/api/sync/live", json("POST"));

export interface ServiceDetail {
  category: string; name: string; month: string; spent: number; count: number; average: number; share: number | null;
  history: { month: string; spent: number }[]; weekdays: number[]; busiest_days: { date: string; count: number }[];
}
export const moveService = (category: string, name: string, to: string) =>
  request<{ moved: number }>("/api/service/move", json("POST", { category, name, to }));

export interface Commitment {
  id: number; name: string; kind: "fixed" | "chosen"; monthly_limit: number; note: string; services: string[]; off_bank: number;
  spent: number; count: number; over: boolean; history: { month: string; spent: number }[];
  /** 1 = monthly; 3, 6 or 12 for costs paid every few months, with the amount each time and the next date. */
  every_months: number; amount: number | null; next_date: string | null; last_date?: string; set_aside?: number;
}
export interface CommitmentSuggestion { service: string; monthly: number; limit: number }
export interface Commitments { month: string; items: Commitment[]; suggestions: CommitmentSuggestion[]; limit: number; spent: number; over: string[] }
export interface CommitmentIn {
  name: string; kind: "fixed" | "chosen"; monthly_limit: number; note: string; services: string[]; off_bank: number;
  every_months?: number; amount?: number | null; next_date?: string | null;
}
export const addCommitment = (c: CommitmentIn) => request<Commitments>("/api/commitments", json("POST", c));
export const editCommitment = (id: number, c: CommitmentIn) => request<Commitments>(`/api/commitments/${id}`, json("PUT", c));
export const deleteCommitment = (id: number) => request<Commitments>(`/api/commitments/${id}`, json("DELETE"));

export interface Question { service: string; tx_id: string; count: number; amount: number; date: string; account: string; has_merchant: boolean }
export type ChatItem =
  | { type: "me" | "bot" | "note"; text: string }
  | { type: "action"; id: number; kind: string; summary: string; detail: string | null; status: "pending" | "done" | "cancelled" | "expired" };
export interface AssistantState {
  conversation: number; items: ChatItem[]; questions: Question[];
  cash: { withdrawn: number; logged: number; unaccounted: number }; ai: boolean;
}
export const sendChat = (text: string) => request<{ conversation: number; items: ChatItem[] }>("/api/assistant/chat", json("POST", { text }));
export type ChatEvent = { type: "text"; text: string } | { type: "status"; text: string } | { type: "error"; text: string; code?: "allowance" }
  | { type: "done"; conversation: number; items: ChatItem[] };
/** The reply as it's written: each server-sent event is passed on as it arrives. */
export async function streamChat(text: string, onEvent: (e: ChatEvent) => void): Promise<void> {
  const r = await send("/api/assistant/chat/stream", { method: "POST", body: JSON.stringify({ text }) });
  if (!r.body) throw new ApiError(`Request failed (${r.status})`, r.status);
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as ChatEvent);
    }
  }
}
export const confirmAction = (id: number) => request<{ result: string; items: ChatItem[] }>(`/api/assistant/actions/${id}/confirm`, json("POST"));
export const cancelAction = (id: number) => request<{ items: ChatItem[] }>(`/api/assistant/actions/${id}/cancel`, json("POST"));
export const newChat = () => request<{ items: ChatItem[] }>("/api/assistant/new", json("POST"));
export interface SortGuess { category: string; reason: string }
export interface SortItem {
  service: string; tx_id: string; date: string; days_ago: number; amount: number; count: number; total: number;
  how: string; shop: string | null; description: string;
  same_day: { name: string; amount: number; category: string }[]; history: { date: string; amount: number }[];
  guess: SortGuess | null;
}
export const guessCategory = (service: string) => request<SortGuess>("/api/sorter/guess", json("POST", { service }));
export const undoAnswer = (service: string) => request<{ moved: number }>("/api/sorter/undo", json("POST", { service }));
export const answerQuestion = (service: string, category: string) =>
  request<{ moved: number; questions: Question[] }>("/api/assistant/answer", json("POST", { service, category }));

export interface Wish { id: number; name: string; price: number; created_at: string; ready_at: string; ready: boolean; hours_of_work: number | null }
export interface YearlyCost { id: number; name: string; yearly_amount: number; due_month: number; monthly: number; next_due: string; months_left: number }
export interface Habits {
  pay_first: { target: number | null; saved: number; since: string; payday: { date: string; amount: number } | null;
    accounts: { id: string; bank: string; name: string; selected: boolean }[] };
  no_spend: { week: { date: string; spent: number | null }[]; count_week: number; days_done: number; best_month: number };
  wishlist: Wish[]; skipped_year: number; hourly_rate: number | null;
  yearly: { items: YearlyCost[]; monthly: number; suggestions: { name: string; yearly_amount: number; due_month: number; last_paid: string }[] };
}
export const setSavingsAccounts = (ids: string[]) => request<Habits>("/api/habits/savings-accounts", json("PUT", { ids }));
export const addWish = (name: string, price: number) => request<Habits>("/api/wishlist", json("POST", { name, price }));
export const decideWish = (id: number, decision: "bought" | "skipped" | "goal") => request<Habits>(`/api/wishlist/${id}/decide`, json("POST", { decision }));
export const addYearly = (name: string, yearly_amount: number, due_month: number) => request<Habits>("/api/yearly", json("POST", { name, yearly_amount, due_month }));
export const deleteYearly = (id: number) => request<Habits>(`/api/yearly/${id}`, json("DELETE"));

/* ---------- Spending: any day, week, pay month or year ---------- */
export type Range = "day" | "week" | "month" | "year";
export interface SpendPayment { date: string; amount: number; category: string; name: string }
export interface SpendDay { date: string; spent: number | null }
export type Highlight =
  | { kind: "category"; category: string; spent: number; usual: number; count: number; usual_count: number | null }
  | ({ kind: "payment" } & SpendPayment)
  | { kind: "weekday"; weekday: number; average: number; overall: number }
  | { kind: "nospend"; days: number; of: number }
  | { kind: "month"; month: string; total: number; usual: number; category: string; amount: number }
  | { kind: "trend"; category: string; before: number; after: number; from: string; to: string }
  | { kind: "heavy_months"; months: string[]; of: number };
export interface Explanation { headline: string; points: string[]; try: string; created_at: string }
export interface SpendView {
  range: Range; off: number; key: string; start: string; end: string; today: string;
  partial: boolean; elapsed: number; length: number; total: number; count: number; can_prev: boolean; can_next: boolean;
  ai: boolean; explanation: Explanation | null;
  // day
  week?: SpendDay[];
  // day, week, month: usual for the same stretch; week and month: the period before too
  usual?: number | null; last?: number | null; last_key?: string; usual_full?: number | null;
  days?: SpendDay[]; trend?: { off: number; key: string; start: string; total: number }[];
  // year
  months?: { key: string; total: number | null; done: boolean }[];
  categories?: { category: string; spent: number; count: number; usual?: number; per_month?: number }[];
  highlights?: Highlight[];
  payments: SpendPayment[];
}
export interface SpendCategory {
  category: string; range: Range; off: number; key: string; start: string; end: string; month: string;
  total: number; count: number; usual_month: number; history: { key: string; total: number }[];
  services: { name: string; spent: number; count: number }[];
}
export const explainPeriod = (range: Range, off: number) => request<Explanation>("/api/spending/explain", json("POST", { range, off }));


/** A weekly habit: fewer payments, under an amount, no-spend days, or waiting 48 hours first. */
export type HabitType = "fewer" | "spend_less" | "nospend" | "wait";
export type HabitStatus = "on_track" | "at_risk" | "missed" | "kept";
export interface Habit {
  id: number; type: HabitType; category: string | null; target: number; baseline: number; goal_id: number | null; created_at: string;
  title: string; value: number; status: HabitStatus; streak: number; saved: number; days_left: number; nudge: string;
}
export interface HabitDetail extends Habit {
  weeks: { start: string; value: number; spent: number | null; status: HabitStatus; counted: boolean; current: boolean }[];
  days: { date: string; value: number | null }[]; goal: { id: number; name: string } | null;
}
export interface HabitSuggestion { type: HabitType; category: string | null; target: number; title: string; why: string; monthly: number | null }
export interface HabitsWeek {
  week: { start: string; end: string; days_left: number }; habits: Habit[]; on_track: number; total: number;
  nudge: { status: HabitStatus; title: string; text: string } | null; saved: number; suggestions: HabitSuggestion[];
}
export const addHabit = (h: { type: HabitType; category: string | null; target: number; goal_id?: number | null }) =>
  request<HabitsWeek & { id: number }>("/api/habits/rules", json("POST", h));
export const patchHabit = (id: number, h: { target?: number; goal_id?: number; clear_goal?: boolean }) =>
  request<HabitDetail>(`/api/habits/rules/${id}`, json("PATCH", h));
export const deleteHabit = (id: number) => request<HabitsWeek>(`/api/habits/rules/${id}`, json("DELETE"));

/* ---------- signed-in person and first-run setup ---------- */
export interface Onboarding { bank_access: boolean; banks_connected: number; done: boolean }
export interface Me {
  email: string; name: string | null; picture: string | null; is_admin: boolean; onboarding: Onboarding;
  /** This month's AI allowance on the shared key, and what's been spent of it (USD). */
  ai_budget_usd?: number; ai_spent_usd?: number;
  /** Where banks send people back: what to allow on their own Enable Banking app. */
  eb_redirect_url?: string;
  credentials?: { enable_banking?: BankAccess; anthropic?: { masked: string; verified_at: string } };
}
export interface BankAccess { app_id: string; key_fingerprint: string; verified_at: string }
/** Verified live with Enable Banking before anything is stored; a 400/502 carries the reason in `detail`. */
export const saveBankAccess = (appId: string, pem: File) => {
  const body = new FormData();
  body.append("app_id", appId);
  body.append("pem", pem);
  return request<BankAccess>("/api/credentials/enable-banking", { method: "POST", body });
};
export const saveAnthropicKey = (api_key: string) => request<{ masked: string }>("/api/credentials/anthropic", json("POST", { api_key }));
export const removeCredential = (kind: "enable_banking" | "anthropic") => request<void>(`/api/credentials/${kind}`, json("DELETE"));
export const signOut = () => fetch("/auth/logout", { method: "POST" }).finally(() => { location.hash = "#/login/signed_out=1"; });
export const finishOnboarding = () => request<void>("/api/onboarding/done", json("POST"));

/* ---------- admin: who can sign in ---------- */
export type PersonStatus = "invited" | "active" | "disabled";
export interface Person {
  id: number; email: string; name: string | null; picture: string | null; is_admin: boolean; status: PersonStatus;
  ai_budget_usd: number; ai_spent_usd: number; created_at: string; last_login_at: string | null;
}
export const invitePerson = (email: string, ai_budget_usd?: number) => request<Person>("/api/people", json("POST", { email, ai_budget_usd }));
export const updatePerson = (id: number, change: { status?: "active" | "disabled"; ai_budget_usd?: number }) =>
  request<Person[]>(`/api/people/${id}`, json("PATCH", change));

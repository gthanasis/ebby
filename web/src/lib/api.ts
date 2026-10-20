import { useCallback, useEffect, useRef, useState } from "react";
import type { Account, AssistantState, Bank, BankAccess, BankList, Category, CategoryDetail, ChatEvent, ChatItem, Commitment, CommitmentSuggestion, Commitments, Connection, Cut, Explanation, ExtraPay, Finding, Goal, GoalsOverview, Habit, HabitDetail, HabitStatus, HabitSuggestion, HabitType, Habits, HabitsWeek, Highlight, Home, InvitedPerson, Ideal, Me, Onboarding, Overview, Pace, PaceCategory, PaydayGuess, Person, PersonStatus, Plan, PlanView, Question, Range, ServiceDetail, Settings, SortGuess, SortItem, SpendCategory, SpendDay, SpendPayment, SpendView, Status, Subscription, Subscriptions, SyncError, TodayMonth, Transaction, WeeklyRead, Wish, Year, YearlyCost } from "./api.gen";
export type { Account, AssistantState, Bank, BankAccess, BankList, Category, CategoryDetail, ChatEvent, ChatItem, Commitment, CommitmentSuggestion, Commitments, Connection, Cut, Explanation, ExtraPay, Finding, Goal, GoalsOverview, Habit, HabitDetail, HabitStatus, HabitSuggestion, HabitType, Habits, HabitsWeek, Highlight, Home, InvitedPerson, Ideal, Me, Onboarding, Overview, Pace, PaceCategory, PaydayGuess, Person, PersonStatus, Plan, PlanView, Question, Range, ServiceDetail, Settings, SortGuess, SortItem, SpendCategory, SpendDay, SpendPayment, SpendView, Status, Subscription, Subscriptions, SyncError, TodayMonth, Transaction, WeeklyRead, Wish, Year, YearlyCost };


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
export const startAuth = (bank: string) => request<{ url: string }>("/api/auth/start", { method: "POST", body: JSON.stringify({ bank }) });
export const completeAuth = (address: string) =>
  request<{ bank: string; accounts: number }>("/api/auth/complete", { method: "POST", body: JSON.stringify({ address }) });

// ---------- redesign ----------

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
export type AssistantModel = "haiku" | "sonnet" | "opus";

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

export const moveService = (category: string, name: string, to: string) =>
  request<{ moved: number }>("/api/service/move", json("POST", { category, name, to }));

export interface CommitmentIn {
  name: string; kind: "fixed" | "chosen"; monthly_limit: number; note: string; services: string[]; off_bank: number;
  every_months?: number; amount?: number | null; next_date?: string | null;
}
export const addCommitment = (c: CommitmentIn) => request<Commitments>("/api/commitments", json("POST", c));
export const editCommitment = (id: number, c: CommitmentIn) => request<Commitments>(`/api/commitments/${id}`, json("PUT", c));
export const deleteCommitment = (id: number) => request<Commitments>(`/api/commitments/${id}`, json("DELETE"));

export const sendChat = (text: string) => request<{ conversation: number; items: ChatItem[] }>("/api/assistant/chat", json("POST", { text }));
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
export const guessCategory = (service: string) => request<SortGuess>("/api/sorter/guess", json("POST", { service }));
export const undoAnswer = (service: string) => request<{ moved: number }>("/api/sorter/undo", json("POST", { service }));
export const answerQuestion = (service: string, category: string) =>
  request<{ moved: number; questions: Question[] }>("/api/assistant/answer", json("POST", { service, category }));

export const setSavingsAccounts = (ids: string[]) => request<Habits>("/api/habits/savings-accounts", json("PUT", { ids }));
export const addWish = (name: string, price: number) => request<Habits>("/api/wishlist", json("POST", { name, price }));
export const decideWish = (id: number, decision: "bought" | "skipped" | "goal") => request<Habits>(`/api/wishlist/${id}/decide`, json("POST", { decision }));
export const addYearly = (name: string, yearly_amount: number, due_month: number) => request<Habits>("/api/yearly", json("POST", { name, yearly_amount, due_month }));
export const deleteYearly = (id: number) => request<Habits>(`/api/yearly/${id}`, json("DELETE"));

/* ---------- Spending: any day, week, pay month or year ---------- */
export const explainPeriod = (range: Range, off: number) => request<Explanation>("/api/spending/explain", json("POST", { range, off }));


export const addHabit = (h: { type: HabitType; category: string | null; target: number; goal_id?: number | null }) =>
  request<HabitsWeek & { id: number }>("/api/habits/rules", json("POST", h));
export const patchHabit = (id: number, h: { target?: number; goal_id?: number; clear_goal?: boolean }) =>
  request<HabitDetail>(`/api/habits/rules/${id}`, json("PATCH", h));
export const deleteHabit = (id: number) => request<HabitsWeek>(`/api/habits/rules/${id}`, json("DELETE"));

/* ---------- signed-in person and first-run setup ---------- */
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
export const invitePerson = (email: string, ai_budget_usd?: number) => request<InvitedPerson>("/api/people", json("POST", { email, ai_budget_usd }));
export const updatePerson = (id: number, change: { status?: "active" | "disabled"; ai_budget_usd?: number }) =>
  request<Person[]>(`/api/people/${id}`, json("PATCH", change));

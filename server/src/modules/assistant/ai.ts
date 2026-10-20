/** The weekly read and on-demand explanations: Claude looks at the spending and says what's driving it. */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import * as clock from "../../shared/clock.js";
import { config, secrets } from "../../config.js";
import * as credentials from "../banks/credentials.js";
import * as db from "../../shared/db.js";
import { type Conn, type Row } from "../../shared/db.js";
import * as aiUsageRepo from "./ai_usage_repo.js";
import * as goalsRepo from "../goals/repo.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import * as users from "../account/repo.js";
import { fmt0, fmt2, isoUtc, PyDate, sorted, sum } from "../../shared/utils/python.js";
import * as aiUsage from "./ai_usage.js";
import { EXPLAIN } from "./prompts/explain.js";
import { WEEKLY_READ } from "./prompts/weekly_read.js";
import { CATEGORIES } from "../../shared/categories.js";
import { ASSISTANT_MODELS } from "../../shared/constants.js";
import { averages, getPlan } from "../plan/service.js";
import { commitmentsView } from "../commitments/service.js";
import { pace } from "../plan/pace.js";
import { serviceName } from "../spending/services.js";
import { subscriptions } from "../spending/subscriptions.js";
import { thisMonth } from "../../shared/months.js";



const Finding = z.object({
  title: z.string().describe("What happened, under 32 characters, e.g. 'Monday Wolt runs'"),
  detail: z.string().describe("The specifics, under 40 characters, e.g. '10 orders on two Mondays'"),
  amount: z.number().describe("Euros involved this month (or per week if unit is 'week')"),
  unit: z.string().describe("'month' for a total, 'week' for a weekly amount"),
  category: z.string().describe("One of the category ids: " + Object.keys(CATEGORIES).join(", ")),
});
const Action = z.object({
  text: z.string().describe("One concrete change, under 70 characters, e.g. 'Cook on Tuesdays and Thursdays'"),
  saves_monthly: z.number().describe("Euros a month this would save, estimated from their own numbers"),
});
const WeeklyRead = z.object({
  headline: z.string().describe("The single most important observation, under 70 characters. Used as a push notification."),
  findings: z.array(Finding).describe("The 3 things that drove spending most, biggest first. Each must be specific."),
  actions: z.array(Action).describe("Up to 3 changes that would matter most, biggest saving first"),
  body: z.string().describe("The full note for anyone who wants detail: 2 to 4 short sentences comparing with plan and recent months."),
});

// Server-side fallback: if a safety classifier declines, the API retries on another model.
const FALLBACK = () => ({ betas: ["server-side-fallback-2026-07-01"] as Anthropic.Beta.AnthropicBeta[], fallbacks: "default" as const });

/** Whether this person can use Claude at all: the owner's key is set, or they added their own. */
export async function available(): Promise<boolean> {
  if (secrets.ANTHROPIC_API_KEY) return true;
  return db.connect(async (conn) => "anthropic" in await credentials.publicInfo(conn));
}

export interface Claude { client: Anthropic; ownKey: boolean; feature: string }  // feature: for the usage log

/** A client for the current person: their own key with no limit, or the owner's key while this month's allowance
 * lasts. Called before every request, so a tool loop stops once it runs out. Throws aiUsage.BudgetExceeded or
 * aiUsage.NoAPIKey, whose messages are fit to show. */
export async function client(feature: string): Promise<Claude> {
  const person = await users.me(db.currentUser()!);
  const now = clock.now();
  const spent = await db.connect((conn) => aiUsageRepo.spentOnOwnerKey(conn, aiUsage.monthBounds(now)[0]));
  const [key, own] = aiUsage.chooseKey({ ownKey: await credentials.anthropicKey(), sharedKey: secrets.ANTHROPIC_API_KEY,
    isAdmin: person.is_admin, spent, budget: person.ai_budget_usd, today: now });
  // The workspace belongs to the owner's key; someone's own key bills wherever it's scoped.
  const defaultHeaders = config.ANTHROPIC_WORKSPACE_ID && !own ? { "anthropic-workspace-id": config.ANTHROPIC_WORKSPACE_ID } : undefined;
  return { client: new Anthropic({ apiKey: key, defaultHeaders }), ownKey: own, feature };
}

/** Logs what one response cost, which is what the allowance counts. */
export async function record(claude: Claude, model: string, usage: aiUsage.Usage) {
  const cost = aiUsage.costUsd(model, usage);
  await db.connect((conn) => aiUsageRepo.add(conn, {
    feature: claude.feature, model, input: usage.input_tokens || 0, cache_read: usage.cache_read_input_tokens || 0,
    cache_write: usage.cache_creation_input_tokens || 0, output: usage.output_tokens || 0, cost_usd: cost, own_key: claude.ownKey,
  }));
}

/** The model for the chat and the sorter: the one picked in Settings, else ASSISTANT_MODEL. */
export async function assistantModel(conn: Conn): Promise<string> {
  const picked = (await db.getMeta(conn, "settings"))?.assistant_model;
  return (picked && ASSISTANT_MODELS[picked]) || config.ASSISTANT_MODEL;
}

/** Request arguments that retry a declined request on another model. Haiku has no such fallback. */
export function fallback(model: string): Partial<ReturnType<typeof FALLBACK>> {
  return model.startsWith("claude-haiku") ? {} : FALLBACK();
}

const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const dayName = (d: PyDate) => DAY_NAMES[d.weekday()];

async function context(conn: Conn): Promise<string> {
  const today = clock.serverToday();
  const since = today.addDays(-90).isoformat();
  const month = thisMonth();
  const p = await pace(conn, month);
  const plan = await getPlan(conn);
  const lines = [`Today: ${today.isoformat()} (${dayName(today)}). Day ${p.elapsed} of ${p.days} of the pay month `
    + `(${p.start} to the day before ${p.end}); 'this month' below means this pay month.`];
  if (plan) {
    lines.push(`Plan: take-home €${fmt0(plan.take_home)}/month, keep €${fmt0(plan.keep)}, spend €${fmt0(sum(Object.values<number>(plan.budgets)))}.`);
    const limit = (plan.limits || {})[month];
    if (limit) lines.push(`This pay month has a working limit of €${fmt0(limit)} on the way down to that plan; budgets below are scaled to it.`);
  }
  lines.push(`This month so far: €${fmt0(p.total)} spent, projected €${fmt0(p.projected)}.`);
  lines.push("\nThis month by category (spent / budget / count):");
  for (const c of p.categories) {
    if (c.spent || c.budget) lines.push(`- ${CATEGORIES[c.category][0]}: €${fmt0(c.spent)} / ${c.budget ? `€${fmt0(c.budget)}` : "no budget"} / ${c.count}`);
  }
  lines.push("\nLast 6 complete months, average per month by category:");
  for (const [cat, avg] of sorted(Object.entries(await averages(conn)), ([, a]) => -a)) lines.push(`- ${CATEGORIES[cat][0]}: €${fmt0(avg)}`);
  const com = await commitmentsView(conn, month);
  if (com.items.length) {
    lines.push("\nCommitted costs (chosen, not to be cut; this month / limit): " + com.items.map((c: Row) =>
      `${c.name} €${fmt0(c.spent)} / €${fmt0(c.monthly_limit)}${c.over ? " (over)" : ""}${c.note ? ` (${c.note})` : ""}`).join("; "));
    lines.push("Budgets and 'this month' above cover free spending only.");
  }
  const subs = await subscriptions(conn);
  if (subs.items.length) {
    lines.push(`\nSubscriptions: ${subs.count} active, €${fmt0(subs.monthly)}/month: `
      + subs.items.map((s: Row) => `${s.name} €${fmt0(s.monthly)}${s.stale ? " (no charge recently)" : ""}`).join(", "));
  }
  const goals = await goalsRepo.all(conn);
  if (goals.length) lines.push("\nSaving for: " + goals.map((g) => `${g.name} €${fmt0(g.price)} by ${g.target_date} (€${fmt0(g.saved)} saved)`).join("; "));
  lines.push("\nTransactions, last 90 days (date,amount,category,merchant,account):");
  for (const r of await transactionsRepo.forContext(conn, since)) {
    const name = serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc).replaceAll(",", " ");
    const cur = r.currency === "EUR" ? "" : ` ${r.currency}`;
    const label = r.commitment_id ? "Committed" : (CATEGORIES[r.category] ?? [r.category])[0];
    lines.push(`${r.date},${fmt2(r.amount)}${cur},${label},${name},${r.account}`);
  }
  return lines.join("\n");
}

/** Logs and swallows what a failed request should never turn into a 500. */
function failed(what: string, e: unknown): null {
  if (e instanceof Anthropic.RateLimitError) console.warn(`${what} rate limited: ${e.message}`);
  else if (e instanceof Anthropic.APIError) console.error(`${what} failed (${e.status}): ${e.message}`);
  else throw e;
  return null;
}

/** Generates and stores this week's read. Returns it, or null when it couldn't be made. */
export async function weeklyRead(): Promise<Row | null> {
  if (!(await available())) return null;
  const [ctx, plan] = await db.connect(async (conn) => [await context(conn), await getPlan(conn)] as const);
  const claude = await client("weekly_read");  // BudgetExceeded / NoAPIKey: the caller decides how to say so
  let response;
  try {
    response = await claude.client.beta.messages.parse({
      model: config.ANTHROPIC_MODEL, max_tokens: 16000, ...FALLBACK(),
      output_config: { effort: "medium", format: betaZodOutputFormat(WeeklyRead) },
      system: WEEKLY_READ, messages: [{ role: "user", content: ctx }],
    });
  } catch (e) {
    return failed("weekly read", e);
  }
  await record(claude, config.ANTHROPIC_MODEL, response.usage);
  if (response.stop_reason === "refusal" || response.parsed_output == null) {
    console.warn(`weekly read not produced (stop_reason=${response.stop_reason})`);
    return null;
  }
  const read = { ...response.parsed_output, created_at: isoUtc(clock.now(), "seconds"), model: response.model, budgets: plan?.budgets ?? null };
  await db.connect((conn) => db.setMeta(conn, "weekly_read", read));
  return read;
}



const Explanation = z.object({
  headline: z.string().describe("The one thing that defined the period, under 60 characters"),
  points: z.array(z.string()).describe("2 or 3 short sentences, each one specific finding with numbers"),
  try: z.string().describe("One concrete thing to try next, with what it would save, under 120 characters"),
});

/** Claude's read of one period. null when it couldn't be made. */
export async function explain(ctx: string): Promise<Row | null> {
  if (!(await available())) return null;
  const claude = await client("explain");
  let response;
  try {
    response = await claude.client.beta.messages.parse({
      model: config.ANTHROPIC_MODEL, max_tokens: 4000, ...FALLBACK(),
      output_config: { effort: "low", format: betaZodOutputFormat(Explanation) },
      system: EXPLAIN, messages: [{ role: "user", content: ctx }],
    });
  } catch (e) {
    return failed("explain", e);
  }
  await record(claude, config.ANTHROPIC_MODEL, response.usage);
  if (response.stop_reason === "refusal" || response.parsed_output == null) return null;
  return { ...response.parsed_output, created_at: isoUtc(clock.now(), "seconds") };
}

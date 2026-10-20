/**
 * The Assistant tab: ask about your money, log cash, and change the app by talking.
 *
 * Claude reads through tools that query the same data the screens show. It never changes anything itself: every
 * change is a proposal stored in assistant_actions, and only the user's "Do it" runs it. The conversation is kept
 * server-side and replayed unchanged, so thinking blocks stay valid.
 */

import { createHash } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import { type Conn, first, type Row } from "../data/db.js";
import { dayMonth, fmt0, fmt2, fmt2c, isoUtc, PyDate, pyDumps, pyRound, sorted, sum } from "../py.js";
import * as ai from "./ai.js";
import * as aiUsage from "./ai_usage.js";
import { CATEGORIES, SPENDING } from "./categories.js";
import * as insights from "./insights.js";
import { ASSISTANT } from "./prompts/assistant.js";
import * as spending from "./spending.js";
import type { Goal } from "../types/entities.js";

const MAX_TOOL_ROUNDS = 6;
const CATEGORY_IDS = Object.keys(CATEGORIES);
const SPEND_IDS = sorted(SPENDING);



type Schema = Record<string, unknown>;
const tool = (name: string, description: string, props: Record<string, Schema>, required?: string[]) => ({
  name, description, strict: true,
  input_schema: { type: "object", properties: props, required: required ?? Object.keys(props), additionalProperties: false },
});
const opt = (kind: string, description?: string): Schema => ({ type: [kind, "null"], ...(description ? { description } : {}) });

const MONTH = opt("string", "Pay month YYYY-MM, or null for the current one");
const RANGE = {
  month: opt("string", "Pay month YYYY-MM, or null to use from/to (all time when all three are null)"),
  from: opt("string", "First day YYYY-MM-DD"), to: opt("string", "Last day YYYY-MM-DD"),
};
const CATEGORY = opt("string", "A category id");
const SUMMARY = { type: "string", description: "One sentence shown on the confirm button" };
const TOOLS = [
  tool("find_payments", "Payments matching every filter given, newest first: up to 20 rows "
    + "(id | date | amount | payee | category; spending is negative) plus how many matched and their sum.",
  { text: opt("string", "Part of the payee or description, e.g. 'wolt'"), amount: opt("number", "About this many euros (within 10%), e.g. 44"),
    category: CATEGORY, ...RANGE }),
  tool("totals", "Spending summed by category, payee or month over a period, biggest first (up to 15 groups). "
    + "Counts spending categories only, not income or transfers.",
  { by: { type: "string", enum: ["category", "payee", "month"] }, text: opt("string", "Only payees or descriptions containing this"), category: CATEGORY, ...RANGE }),
  tool("get_overview", "A pay month against the plan: free spending, projection, each category against its budget, "
    + "committed costs, cash.", { month: MONTH }),
  tool("get_plan", "The plan: take-home, keep, committed limits, free to spend, budgets per category.", {}),
  tool("list_goals", "Savings goals with progress and what they need per week.", {}),
  tool("propose_set_payment_category", "Draft: move one payment to a category; the payee's other payments stay.",
    { transaction_id: { type: "string", description: "The id from find_payments" }, category: { type: "string", enum: CATEGORY_IDS }, summary: SUMMARY }),
  tool("propose_set_category", "Draft: move every payment to a payee to a category, now and later.",
    { service: { type: "string", description: "Payee as find_payments shows it" }, category: { type: "string", enum: CATEGORY_IDS }, summary: SUMMARY }),
  tool("propose_commitment", "Draft: a commitment (fixed bill or chosen cost) with a monthly limit.",
    { name: { type: "string" }, kind: { type: "string", enum: ["fixed", "chosen"] }, monthly_limit: { type: "number" },
      services: { type: "array", items: { type: "string" } },
      off_bank: { type: "number", description: "Monthly amount paid outside the bank, e.g. rent in cash; 0 if none" },
      note: { type: "string" }, summary: SUMMARY }),
  tool("propose_budget", "Draft: the monthly budget of one free-spending category.",
    { category: { type: "string", enum: SPEND_IDS }, amount: { type: "number" }, summary: SUMMARY }),
  tool("propose_plan", "Draft: change take-home pay and/or the amount kept each month.",
    { take_home: { type: "number" }, keep: { type: "number" }, summary: SUMMARY }),
  tool("propose_goal", "Draft: a new savings goal.",
    { name: { type: "string" }, price: { type: "number" }, target_date: { type: "string", description: "YYYY-MM-DD" }, summary: SUMMARY }),
  tool("propose_goal_saved", "Draft: money put aside for (or taken from) a goal.",
    { goal_id: { type: "integer" }, add: { type: "number", description: "Negative to take out" }, summary: SUMMARY }),
  tool("propose_wish", "Draft: put something on the 48-hour 'thinking about it' list.",
    { name: { type: "string" }, price: { type: "number" }, summary: SUMMARY }),
  tool("propose_log_cash", "Draft: log cash spending; it comes out of what was withdrawn.",
    { amount: { type: "number" }, category: { type: "string", enum: SPEND_IDS }, note: { type: "string", description: "Where or what, e.g. 'bakery'" },
      date: { type: "string", description: "YYYY-MM-DD" }, summary: SUMMARY }),
];

// ---------- read tools ----------

const month = (m: string | null | undefined) => m || insights.thisMonth();

async function overview(conn: Conn, m: string): Promise<Row> {
  const p = await insights.pace(conn, m);
  const com = await insights.commitmentsView(conn, m);
  return {
    month: m, free_spent: p.total, free_plan: p.planned, projected: p.projected, day: p.elapsed, days: p.days,
    categories: p.categories.filter((c: Row) => c.spent || c.budget)
      .map((c: Row) => ({ category: c.category, spent: c.spent, budget: c.budget, status: c.status, count: c.count, habit: c.habit })),
    committed: com.items.map((c: Row) => ({ name: c.name, spent: c.spent, limit: c.monthly_limit, over: c.over })),
    cash: await insights.cashView(conn, m),
  };
}

/** Every payment the filters allow, newest first, named the way the app shows payees. */
async function payments(conn: Conn, args: Row): Promise<Row[]> {
  const where = ["t.duplicate_of IS NULL", "t.status != 'OFFSET'"];
  const params: unknown[] = [];
  if (args.month) {
    const [start, end] = insights.monthBounds(args.month);
    where.push("t.date >= ? AND t.date < ?"); params.push(start, end);
  } else {
    if (args.from) { where.push("t.date >= ?"); params.push(args.from); }
    if (args.to) { where.push("t.date <= ?"); params.push(args.to); }
  }
  if (args.category) { where.push("t.category = ?"); params.push(args.category); }
  if (args.amount) { where.push("ABS(ABS(t.amount) - ?) <= ?"); params.push(Math.abs(args.amount), Math.max(1.0, Math.abs(args.amount) * 0.1)); }
  const rows = (await conn.execute(`SELECT t.id, t.date, t.amount, t.merchant, t.description, t.mcc, t.category, a.is_card
    FROM transactions t JOIN accounts a ON a.id = t.account WHERE ${where.join(" AND ")} ORDER BY t.date DESC, t.id`, params)).rows;
  const text = (args.text || "").trim().toLowerCase();
  const out = [];
  for (const r of rows) {
    const payee = insights.serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc);
    if (text && !`${payee} ${r.merchant || ""} ${r.description || ""}`.toLowerCase().includes(text)) continue;
    out.push({ id: r.id, date: r.date, amount: r.amount, payee, category: r.category });
  }
  return out;
}

async function find(conn: Conn, args: Row): Promise<Row> {
  const rows = await payments(conn, args);
  return {
    matched: rows.length, sum: pyRound(sum(rows.map((r) => r.amount)), 2),
    rows: rows.slice(0, 20).map((r) => `${ref(r.id)} | ${r.date} | ${fmt2(r.amount)} | ${r.payee} | ${r.category}`),
  };
}

async function totals(conn: Conn, args: Row): Promise<Row> {
  const groups = new Map<string, [number, number]>();
  for (const r of await payments(conn, args)) {
    if (!SPENDING.has(r.category) || r.amount >= 0) continue;
    const key = args.by === "category" ? r.category : args.by === "payee" ? r.payee : insights.monthOf(r.date);
    const g = groups.get(key) ?? [0.0, 0];
    g[0] -= r.amount; g[1] += 1;
    groups.set(key, g);
  }
  const ranked = sorted(groups.entries(), ([k, v]) => (args.by === "month" ? k : -v[0]));
  return {
    spent: pyRound(sum([...groups.values()].map((g) => g[0])), 2), groups: groups.size,
    rows: ranked.slice(0, 15).map(([k, v]) => `${k}: ${fmt2(v[0])} (${v[1]} payments)`),
  };
}

/** A short stand-in for a transaction id (the bank's ids run to 150 characters), stable across calls. */
const ref = (txId: string) => createHash("sha1").update(txId).digest("hex").slice(0, 10);

async function txFromRef(conn: Conn, r: string): Promise<string | null> {
  const want = r.trim().toLowerCase();
  return (await conn.execute("SELECT id FROM transactions")).rows.map((x) => x.id).find((id) => ref(id) === want) ?? null;
}

async function plan(conn: Conn): Promise<Row> {
  const p = await insights.getPlan(conn);
  const committed = await insights.committedTotal(conn);
  if (!p) return { plan: null, committed_limits: committed };
  return { ...p, committed_limits: committed, free_to_spend: pyRound(p.take_home - p.keep - committed, 2) };
}

async function goals(conn: Conn): Promise<Row[]> {
  const out = [];
  for (const r of await conn.execute<Goal>("SELECT * FROM goals ORDER BY target_date")) {
    const g = await insights.goalView(conn, r);
    out.push({ id: g.id, name: g.name, price: g.price, saved: g.saved, target_date: g.target_date, weekly: g.weekly, monthly: g.monthly });
  }
  return out;
}

async function runRead(conn: Conn, name: string, args: Row): Promise<unknown> {
  if (name === "get_overview") return overview(conn, month(args.month));
  if (name === "find_payments") return find(conn, args);
  if (name === "totals") return totals(conn, args);
  if (name === "get_plan") return plan(conn);
  if (name === "list_goals") return goals(conn);
  throw new Error(name);
}

// ---------- actions (proposed by Claude, run only on the user's confirm) ----------

const now = () => isoUtc(clock.now(), "seconds");

async function propose(conn: Conn, conversation: number, name: string, args: Row): Promise<Row> {
  const kind = name.replace(/^propose_/, "");
  const summary = String(args.summary ?? "").trim() || kind.replaceAll("_", " ");
  delete args.summary;
  if (kind === "set_payment_category") {
    const txId = await txFromRef(conn, args.transaction_id);
    if (!txId) return { error: "No payment with that id; use an id from find_payments." };
    args.transaction_id = txId;
  }
  await conn.execute("INSERT INTO assistant_actions(conversation, kind, params, summary, created_at) VALUES(?, ?, ?, ?, ?)",
    [conversation, kind, pyDumps(args), summary, now()]);
  return { status: "waiting for the user's confirmation", action_id: first((await conn.execute("SELECT lastval()")).one()) };
}

/** Executes a confirmed proposal. Returns a short result line for the chat. */
export async function runAction(actionId: number): Promise<string> {
  return db.connect(async (conn) => {
    const row = (await conn.execute("SELECT * FROM assistant_actions WHERE id = ?", [actionId])).one();
    if (!row || row.status !== "pending") throw new Error("That change was already handled.");
    const p = JSON.parse(row.params);
    const kind: string = row.kind;
    let result: string;
    if (kind === "set_category") {
      const n = await insights.setServiceCategory(conn, p.service, p.category);
      result = `Moved ${n} ${p.service} payments to ${CATEGORIES[p.category][0]}.`;
    } else if (kind === "set_payment_category") {
      // The same rule the Spending list saves when one payment's category is changed.
      const tx = (await conn.execute("SELECT date, amount FROM transactions WHERE id = ?", [p.transaction_id])).one();
      if (!tx) throw new Error("That payment is no longer there.");
      await conn.execute("INSERT INTO rules(merchant, category) VALUES(?, ?) ON CONFLICT(user_id, merchant) DO UPDATE SET category = excluded.category",
        [`tx:${p.transaction_id}`, p.category]);
      await db.recategorize(conn);
      result = `Moved the €${fmt2c(Math.abs(tx.amount))} payment on ${dayMonth(PyDate.fromisoformat(tx.date.slice(0, 10)))} to ${CATEGORIES[p.category][0]}.`;
    } else if (kind === "commitment") {
      await conn.execute(`INSERT INTO commitments(name, kind, monthly_limit, note, services, off_bank, created_at)
                          VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.kind, p.monthly_limit, p.note ?? "", pyDumps(p.services ?? []), Math.max(0, p.off_bank ?? 0), now()]);
      await insights.assignCommitments(conn);
      result = `${p.name} is committed, limit €${fmt0(p.monthly_limit)} a month.`;
    } else if (kind === "budget") {
      const current = await insights.getPlan(conn);
      if (!current) throw new Error("Set up the plan first.");
      current.budgets[p.category] = Number(p.amount);
      await db.setMeta(conn, "plan", current);
      result = `${CATEGORIES[p.category][0]} budget is now €${fmt0(p.amount)} a month.`;
    } else if (kind === "plan") {
      const current = await insights.getPlan(conn);
      await insights.savePlan(conn, p.take_home, p.keep, current ? current.budgets : null);
      result = `Plan updated: take-home €${fmt0(p.take_home)}, keep €${fmt0(p.keep)}.`;
    } else if (kind === "goal") {
      if (PyDate.fromisoformat(p.target_date).n <= clock.serverToday().n) throw new Error("The goal date has to be in the future.");
      await conn.execute("INSERT INTO goals(name, price, saved, target_date, created_at) VALUES(?, ?, 0, ?, ?)",
        [p.name, p.price, p.target_date, clock.serverToday().isoformat()]);
      result = `Added ${p.name}: €${fmt0(p.price)} by ${p.target_date}.`;
    } else if (kind === "goal_saved") {
      await conn.execute("UPDATE goals SET saved = GREATEST(0, saved + ?) WHERE id = ?", [p.add, p.goal_id]);
      result = "Goal updated.";
    } else if (kind === "wish") {
      const habits = await import("./habits.js");
      await habits.addWish(conn, p.name, p.price);
      result = `${p.name} is on the thinking-about-it list. I'll ask again in two days.`;
    } else if (kind === "log_cash") {
      await insights.logCash(conn, p.amount, p.category, p.note ?? "", p.date || insights.localToday().isoformat());
      const left = (await insights.cashView(conn, p.date ? insights.monthOf(p.date) : insights.thisMonth())).unaccounted;
      result = `Logged €${fmt2c(p.amount)} cash as ${CATEGORIES[p.category][0]}. €${fmt0(left)} of this month's cash is still unaccounted for.`;
    } else {
      throw new Error(`Unknown change: ${kind}`);
    }
    await conn.execute("UPDATE assistant_actions SET status = 'done' WHERE id = ?", [actionId]);
    await store(conn, row.conversation, "user", [{ type: "text", text: `[I confirmed: ${row.summary}. Result: ${result}]` }]);
    return result;
  });
}

export async function cancelAction(actionId: number) {
  await db.connect(async (conn) => {
    const row = (await conn.execute("SELECT * FROM assistant_actions WHERE id = ? AND status = 'pending'", [actionId])).one();
    if (row) {
      await conn.execute("UPDATE assistant_actions SET status = 'cancelled' WHERE id = ?", [actionId]);
      await store(conn, row.conversation, "user", [{ type: "text", text: `[I cancelled: ${row.summary}]` }]);
    }
  });
}

// ---------- conversation ----------

async function store(conn: Conn, conversation: number, role: string, content: unknown[]) {
  await conn.execute("INSERT INTO assistant_messages(conversation, role, content, created_at) VALUES(?, ?, ?, ?)",
    [conversation, role, pyDumps(content, { ensureAscii: false }), now()]);
}

export async function currentConversation(conn: Conn): Promise<number> {
  return (await db.getMeta(conn, "assistant_conversation")) || 1;
}

export async function newConversation() {
  await db.connect(async (conn) => db.setMeta(conn, "assistant_conversation", (await currentConversation(conn)) + 1));
}

/** API messages, merging consecutive same-role turns (confirm notes follow tool results). */
async function history(conn: Conn, conversation: number): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const msgs: any[] = [];
  for (const r of await conn.execute("SELECT role, content FROM assistant_messages WHERE conversation = ? ORDER BY id", [conversation])) {
    const content = JSON.parse(r.content);
    if (msgs.length && msgs[msgs.length - 1].role === r.role) msgs[msgs.length - 1].content = [...msgs[msgs.length - 1].content, ...content];
    else msgs.push({ role: r.role, content });
  }
  return msgs;
}

/** The payment a single-payment change is about, so the card shows which one it is. */
async function detail(conn: Conn, kind: string, params: string): Promise<string | null> {
  if (kind !== "set_payment_category") return null;
  const r = (await conn.execute(`SELECT t.date, t.amount, t.merchant, t.description, t.mcc, a.is_card FROM transactions t
                                 JOIN accounts a ON a.id = t.account WHERE t.id = ?`, [JSON.parse(params).transaction_id])).one();
  if (!r) return null;
  const name = insights.serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc);
  return `${name} · €${fmt2c(Math.abs(r.amount))} · ${dayMonth(PyDate.fromisoformat(r.date.slice(0, 10)), true)}`;
}

const CONTEXT = "[Context";

/** What the Assistant tab shows: your messages, Claude's text, and change cards. */
export async function display(conversation: number | null = null): Promise<Row> {
  return db.connect(async (conn) => {
    const conv = conversation || await currentConversation(conn);
    const actions = new Map<number, Row>();
    for (const r of await conn.execute("SELECT id, kind, params, summary, status FROM assistant_actions WHERE conversation = ?", [conv])) {
      const { params, ...rest } = r;
      actions.set(r.id, { ...rest, detail: await detail(conn, r.kind, params) });
    }
    const items: Row[] = [];
    for (const r of await conn.execute("SELECT role, content FROM assistant_messages WHERE conversation = ? ORDER BY id", [conv])) {
      for (const block of JSON.parse(r.content)) {
        const t = block.type;
        if (r.role === "user" && t === "text" && block.text.startsWith(CONTEXT)) continue;
        if (r.role === "user" && t === "text" && !block.text.startsWith("[I ")) items.push({ type: "me", text: block.text });
        else if (r.role === "user" && t === "text") items.push({ type: "note", text: block.text.replace(/^\[+|\]+$/g, "") });
        else if (r.role === "user" && t === "tool_result") {
          let res: any = {};
          try { res = typeof block.content === "string" ? JSON.parse(block.content) : {}; } catch { res = {}; }
          if (res && typeof res === "object" && actions.has(res.action_id)) items.push({ type: "action", ...actions.get(res.action_id) });
        } else if (r.role === "assistant" && t === "text" && (block.text || "").trim()) items.push({ type: "bot", text: block.text });
      }
    }
    return { conversation: conv, items };
  });
}

const TOOL_STATUS: Record<string, string> = {
  find_payments: "Searching your payments", totals: "Adding it up", get_overview: "Looking at the month",
  get_plan: "Checking your plan", list_goals: "Checking your goals",
};

/** The little the assistant knows before any tool call, sent with each message. It goes into the message rather
 * than the system prompt so the conversation stays append-only and the prompt caches. */
async function context(conn: Conn): Promise<string> {
  const today = insights.localToday();
  const v = await spending.view(conn, "month", 0);
  let line = `${CONTEXT}: today ${today.isoformat()} (${ai.dayName(today)}); pay month ${v.key} runs ${v.start} to ${v.end}, `
    + `day ${v.elapsed} of ${v.length}; free spending so far ${fmt0(v.total, false)}, usual by now ${fmt0(v.usual || 0, false)}`;
  const p = await plan(conn);
  if (p.free_to_spend != null) line += `; free to spend a month ${fmt0(p.free_to_spend, false)}`;
  const extra = await insights.extraPay(conn);
  if (extra.length) line += `; next extra pay ${extra[0].name.toLowerCase()} about ${fmt0(extra[0].amount, false)} on ${extra[0].date} (not in the monthly budget)`;
  const cash = (await insights.cashView(conn, insights.thisMonth())).unaccounted;
  return line + (cash ? `; cash not yet accounted for ${fmt0(cash, false)}]` : "]");
}

/** The whole answer at once (kept for callers that don't stream). */
export async function chat(text: string): Promise<Row> {
  let last: Row = {};
  for await (const event of chatEvents(text)) {
    if (event.type === "error") throw new Error(event.text);
    last = event;
  }
  const { type: _, ...rest } = last;
  return rest;
}

/** Drops empty fields, as the Python app stored content blocks (model_dump(exclude_none=True)). */
const withoutNulls = (block: Row) => Object.fromEntries(Object.entries(block).filter(([, v]) => v != null));

/** The answer as it's written: text pieces, a status while it looks something up, then the finished conversation.
 * Errors arrive as an event, so the stream always ends cleanly. */
export async function* chatEvents(text: string): AsyncGenerator<Row> {
  if (!(await ai.available())) {
    yield { type: "error", text: "The assistant needs an Anthropic key. Add your own in Settings." };
    return;
  }
  const [conv, model] = await db.connect(async (conn) => {
    const c = await currentConversation(conn);
    // A reply leaves earlier unconfirmed drafts behind; they stay visible but can't run anymore.
    await conn.execute("UPDATE assistant_actions SET status = 'expired' WHERE conversation = ? AND status = 'pending'", [c]);
    await store(conn, c, "user", [{ type: "text", text: await context(conn) }, { type: "text", text }]);
    return [c, await ai.assistantModel(conn)] as const;
  });
  // Tools and instructions never change, so they cache; the conversation after them only grows.
  const system = [{ type: "text" as const, text: ASSISTANT.replace("{categories}", CATEGORY_IDS.join(", ")), cache_control: { type: "ephemeral" as const } }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const messages = await db.connect((conn) => history(conn, conv));
    let claude;
    try {
      claude = await ai.client("assistant");
    } catch (e) {
      if (e instanceof aiUsage.BudgetExceeded || e instanceof aiUsage.NoAPIKey) { yield { type: "error", text: e.message }; return; }
      throw e;
    }
    let response: Anthropic.Beta.BetaMessage;
    try {
      const stream = claude.client.beta.messages.stream({
        model, max_tokens: 16000, system, tools: TOOLS as any, messages,
        output_config: { effort: "low" }, cache_control: { type: "ephemeral" }, ...ai.fallback(model),
      } as any);
      for await (const event of stream as AsyncIterable<any>) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
      }
      response = await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) { yield { type: "error", text: "The assistant is busy right now. Try again in a moment." }; return; }
      if (e instanceof Anthropic.APIConnectionError) { yield { type: "error", text: "Couldn't reach the assistant. Try again in a moment." }; return; }
      if (e instanceof Anthropic.APIError) {
        console.error(`assistant failed (${e.status}): ${e.message}`);
        yield { type: "error", text: "The assistant couldn't answer right now. Try again in a moment." };
        return;
      }
      throw e;
    }
    await ai.record(claude, model, response.usage);
    const content = response.content.map((b) => withoutNulls(b as Row));
    await db.connect((conn) => store(conn, conv, "assistant", content));
    if (response.stop_reason === "refusal") {
      await db.connect((conn) => store(conn, conv, "assistant", [{ type: "text", text: "I can't help with that one." }]));
      break;
    }
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !uses.length) break;
    for (const u of uses) if (u.name in TOOL_STATUS) yield { type: "status", text: `${TOOL_STATUS[u.name]}…` };
    await db.connect(async (conn) => {
      const results = [];
      for (const u of uses) {
        try {
          const args = { ...(u.input as Row) };
          const out = u.name.startsWith("propose_") ? await propose(conn, conv, u.name, args) : await runRead(conn, u.name, args);
          results.push({ type: "tool_result", tool_use_id: u.id, content: pyDumps(out, { ensureAscii: false }) });
        } catch (e: any) {  // report to Claude, which can explain or retry
          console.warn(`assistant tool ${u.name} failed: ${e?.message ?? e}`);
          results.push({ type: "tool_result", tool_use_id: u.id, content: `Error: ${e?.message ?? e}`, is_error: true });
        }
      }
      await store(conn, conv, "user", results);
    });
  }
  yield { type: "done", ...(await display(conv)) };
}

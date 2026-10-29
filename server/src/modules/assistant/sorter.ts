/**
 * Sorting the payments the app couldn't place, one at a time.
 *
 * Banks send no time or place, so each payment comes with what can be told about it: when it was, the type of shop
 * the bank files it under, what else was paid that day, and earlier payments to the same payee. Claude reads that and
 * makes a guess with a reason; the guess is kept per payee, so it's made once. Answering moves every payment to that
 * payee, now and later.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

import * as clock from "../../shared/clock.js";
import * as db from "../../shared/db.js";
import type { Conn, Row } from "../../shared/db.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { fmt2, isoUtc, PyDate } from "../../shared/utils/python.js";
import * as ai from "./ai.js";
import { type SortItem, toSortItem } from "./converters.js";
import * as aiUsage from "./ai_usage.js";
import { CATEGORIES } from "../../shared/categories.js";
import { SORTER_GUESS } from "./prompts/sorter.js";
import * as spending from "../spending/service.js";
import { localToday } from "../../shared/months.js";
import { questions } from "../spending/questions.js";
import * as memory from "./memory.js";


const GUESS_KEY = "sorter_guesses";

/** Every payee waiting in Other, each with what can be told about its latest payment. */
export async function items(conn: Conn): Promise<SortItem[]> {
  const out: SortItem[] = [];
  const guesses = (await db.getMeta(conn, GUESS_KEY)) || {};
  const today = localToday();
  for (const q of await questions(conn, 50)) {
    const t = await transactionsRepo.withAccount(conn, q.tx_id);
    if (!t) continue;
    const d = PyDate.fromisoformat(t.date);
    const sameDay = await spending.rows(conn, d, d);
    const history = await transactionsRepo.earlierToPayee(conn, t.merchant, t.description, t.id);
    out.push(toSortItem(q, t, today, sameDay, history, guesses[q.service] ?? null));
  }
  return out;
}

const Guess = z.object({
  category: z.string().describe("One category id from the list"),
  reason: z.string().describe("Why, in one or two short sentences that name the clues used, e.g. the shop type or the day's other payments"),
  remembered: z.array(z.number()).describe("Ids of the remembered lines the guess relies on; empty if none"),
});



function context(item: Row, remembered: string): string {
  const lines = [`Payment: €${fmt2(item.amount)} to "${item.service}" (bank text: "${item.description}") on ${item.date}, `
    + `${item.days_ago} days ago, a ${ai.dayName(PyDate.fromisoformat(item.date))}, by ${item.how}.`];
  if (item.count > 1) lines.push(`There are ${item.count} such payments in the last 90 days, €${fmt2(item.total)} in all.`);
  lines.push(`Shop type from the bank: ${item.shop || "none given"}.`);
  lines.push("Other payments that day: " + (item.same_day.map((p: Row) => `${p.name} €${fmt2(p.amount)} (${p.category})`).join("; ") || "none") + ".");
  lines.push("Earlier payments to this payee: " + (item.history.map((h: Row) => `${h.date} €${fmt2(h.amount)}`).join("; ") || "none") + ".");
  if (remembered) lines.push(`What this person has asked you to remember (id, then their words):\n${remembered}`);
  lines.push("Categories (id: name): " + Object.entries(CATEGORIES).map(([k, v]) => `${k}: ${v[0]}`).join("; "));
  return lines.join("\n");
}

/** Claude's guess for a payee, made once and kept. */
export async function guess(conn: Conn, service: string): Promise<Row | null> {
  const guesses = (await db.getMeta(conn, GUESS_KEY)) || {};
  if (service in guesses) return guesses[service];
  const item = (await items(conn)).find((i) => i.service === service);
  if (!item || !(await ai.available())) return null;
  let claude;
  try {
    claude = await ai.client("sorter");
  } catch (e) {
    if (aiUsage.isAllowanceError(e)) { console.info(`sorter guess skipped: ${e.message}`); return null; }
    throw e;
  }
  const model = await ai.assistantModel(conn);
  const lines = await memory.promptLines(conn);
  let response;
  try {
    response = await claude.client.beta.messages.parse({
      model, max_tokens: 2000, output_config: { effort: "low", format: betaZodOutputFormat(Guess) }, system: SORTER_GUESS,
      messages: [{ role: "user", content: context(item, lines.text) }], ...ai.fallback(model),
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) { console.warn(`sorter guess failed: ${e.message}`); return null; }
    throw e;
  }
  await ai.record(claude, model, response.usage);
  const g = response.parsed_output;
  if (response.stop_reason === "refusal" || g == null || !(g.category in CATEGORIES)) return null;
  const used = g.remembered.filter((id) => lines.ids.includes(id));
  await memory.markUsed(conn, used);
  const texts = (await memory.list(conn)).filter((m) => used.includes(m.id)).map((m) => m.text);
  const result = { category: g.category, reason: g.reason, at: isoUtc(clock.now(), "seconds"), ...(texts.length ? { remembered: texts } : {}) };
  guesses[service] = result;
  await db.setMeta(conn, GUESS_KEY, guesses);
  return result;
}

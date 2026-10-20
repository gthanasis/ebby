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
import { fmt2, isoUtc, PyDate, pyRound } from "../../shared/utils/python.js";
import * as ai from "./ai.js";
import * as aiUsage from "./ai_usage.js";
import { CATEGORIES } from "../../shared/categories.js";
import { SORTER_GUESS } from "./prompts/sorter.js";
import * as spending from "../spending/service.js";
import { SHOP_TYPES } from "../../shared/reference/mcc.js";
import { localToday } from "../../shared/months.js";
import { questions } from "../spending/questions.js";


const GUESS_KEY = "sorter_guesses";

function how(row: Row): string {
  const bank = row.bank;
  if (row.is_card) return `${bank} card`;
  if (row.mcc) return `${bank} debit card`;  // a shop type means a card purchase, even when it's booked on the current account
  if ((row.description || "").startsWith("ΕΝΤ")) return `${bank} payment order`;
  return bank === "Revolut" ? `${bank} transfer` : `${bank} payment`;
}

/** Every payee waiting in Other, each with what can be told about its latest payment. */
export async function items(conn: Conn): Promise<Row[]> {
  const out = [];
  const guesses = (await db.getMeta(conn, GUESS_KEY)) || {};
  const today = localToday();
  for (const q of await questions(conn, 50)) {
    const t = await transactionsRepo.withAccount(conn, q.tx_id);
    if (!t) continue;
    const d = PyDate.fromisoformat(t.date);
    const sameDay = (await spending.rows(conn, d, d)).filter((r) => r.name !== q.service).map((r) => ({ name: r.name, amount: r.amount, category: r.category }));
    const history = (await transactionsRepo.earlierToPayee(conn, t.merchant, t.description, t.id))
      .map((r) => ({ date: r.date, amount: pyRound(-r.amount, 2) }));
    out.push({
      service: q.service, tx_id: t.id, date: t.date, days_ago: today.diffDays(d),
      amount: pyRound(-t.amount, 2), count: q.count, total: q.amount,
      how: how(t), shop: SHOP_TYPES[String(t.mcc || "")] ?? null, description: t.description,
      same_day: sameDay.slice(0, 6), history, guess: guesses[q.service] ?? null,
    });
  }
  return out;
}

const Guess = z.object({
  category: z.string().describe("One category id from the list"),
  reason: z.string().describe("Why, in one or two short sentences that name the clues used, e.g. the shop type or the day's other payments"),
});



function context(item: Row): string {
  const lines = [`Payment: €${fmt2(item.amount)} to "${item.service}" (bank text: "${item.description}") on ${item.date}, `
    + `${item.days_ago} days ago, a ${ai.dayName(PyDate.fromisoformat(item.date))}, by ${item.how}.`];
  if (item.count > 1) lines.push(`There are ${item.count} such payments in the last 90 days, €${fmt2(item.total)} in all.`);
  lines.push(`Shop type from the bank: ${item.shop || "none given"}.`);
  lines.push("Other payments that day: " + (item.same_day.map((p: Row) => `${p.name} €${fmt2(p.amount)} (${p.category})`).join("; ") || "none") + ".");
  lines.push("Earlier payments to this payee: " + (item.history.map((h: Row) => `${h.date} €${fmt2(h.amount)}`).join("; ") || "none") + ".");
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
    if (e instanceof aiUsage.BudgetExceeded || e instanceof aiUsage.NoAPIKey) { console.info(`sorter guess skipped: ${e.message}`); return null; }
    throw e;
  }
  const model = await ai.assistantModel(conn);
  let response;
  try {
    response = await claude.client.beta.messages.parse({
      model, max_tokens: 2000, output_config: { effort: "low", format: betaZodOutputFormat(Guess) }, system: SORTER_GUESS,
      messages: [{ role: "user", content: context(item) }], ...ai.fallback(model),
    });
  } catch (e) {
    if (e instanceof Anthropic.APIError) { console.warn(`sorter guess failed: ${e.message}`); return null; }
    throw e;
  }
  await ai.record(claude, model, response.usage);
  const g = response.parsed_output;
  if (response.stop_reason === "refusal" || g == null || !(g.category in CATEGORIES)) return null;
  const result = { category: g.category, reason: g.reason, at: isoUtc(clock.now(), "seconds") };
  guesses[service] = result;
  await db.setMeta(conn, GUESS_KEY, guesses);
  return result;
}

/** The chat and the sorter as the API shows them, from what was stored and read: pure, no database. */

import type { z } from "zod";

import type { Row } from "../../shared/db.js";
import type { PayeeFields } from "../../shared/ledger/transactions.js";
import { SHOP_TYPES } from "../../shared/reference/mcc.js";
import { PyDate, pyRound } from "../../shared/utils/python.js";
import type { AssistantAction, SorterGuess } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type ChatAction = z.infer<typeof S.ChatAction>;
export type ChatItem = z.infer<typeof S.ChatItem>;
export type Conversation = z.infer<typeof S.Conversation>;
export type SortItem = z.infer<typeof S.SortItem>;

/** How the assistant's context note starts; it's stored with your message but never shown. */
export const CONTEXT = "[Context";

export function toChatAction(r: Pick<AssistantAction, "id" | "kind" | "summary" | "status">, detail: string | null): ChatAction {
  return { type: "action", id: r.id, kind: r.kind, summary: r.summary, status: r.status as ChatAction["status"], detail };
}

/** One stored content block as the tab shows it, or null when it isn't shown. */
export function toChatItem(role: string, block: Row, actions: Map<number, ChatAction>): ChatItem | null {
  if (role === "assistant") return block.type === "text" && (block.text || "").trim() ? { type: "bot", text: block.text } : null;
  if (role !== "user") return null;
  if (block.type === "tool_result") {
    let res: any = {};
    try { res = typeof block.content === "string" ? JSON.parse(block.content) : {}; } catch { res = {}; }
    return res && typeof res === "object" && actions.has(res.action_id) ? actions.get(res.action_id)! : null;
  }
  if (block.type !== "text" || block.text.startsWith(CONTEXT)) return null;
  if (block.text.startsWith("[I ")) return { type: "note", text: block.text.replace(/^\[+|\]+$/g, "") };
  return { type: "me", text: block.text };
}

type SortTx = PayeeFields & { id: string; date: string; amount: number; bank: string | null };

function how(row: SortTx): string {
  const bank = row.bank;
  if (row.is_card) return `${bank} card`;
  if (row.mcc) return `${bank} debit card`;  // a shop type means a card purchase, even when it's booked on the current account
  if ((row.description || "").startsWith("ΕΝΤ")) return `${bank} payment order`;
  return bank === "Revolut" ? `${bank} transfer` : `${bank} payment`;
}

/** A payee waiting in Other, with its latest payment, that day's other payments and earlier ones to it. */
export function toSortItem(q: Row, t: SortTx, today: PyDate, sameDay: { name: string; amount: number; category: string }[],
  history: { date: string; amount: number }[], guess: SorterGuess | null): SortItem {
  const d = PyDate.fromisoformat(t.date);
  return {
    service: q.service, tx_id: t.id, date: t.date, days_ago: today.diffDays(d),
    amount: pyRound(-t.amount, 2), count: q.count, total: q.amount,
    how: how(t), shop: SHOP_TYPES[String(t.mcc || "")] ?? null, description: t.description,
    same_day: sameDay.filter((r) => r.name !== q.service).map((r) => ({ name: r.name, amount: r.amount, category: r.category })).slice(0, 6),
    history: history.map((r) => ({ date: r.date, amount: pyRound(-r.amount, 2) })),
    guess,
  };
}

/** What the assistant's routes return: the chat, the sorter, and the weekly read and explanations it writes. */

import { z } from "zod";

/** A payee left in Other, as spending's questions.ts lists it. */
export const Question = z.strictObject({
  service: z.string(), tx_id: z.string(), count: z.number(), amount: z.number(), date: z.string(), account: z.string(), has_merchant: z.boolean(),
});

/** This month's cash, as spending's cash.ts works it out. */
export const Cash = z.strictObject({ withdrawn: z.number(), logged: z.number(), unaccounted: z.number() });

/** A change Claude proposed, as its card shows it. */
export const ChatAction = z.strictObject({
  type: z.literal("action"), id: z.number(), kind: z.string(), summary: z.string(),
  status: z.enum(["pending", "done", "cancelled", "expired"]), detail: z.string().nullable(),
});

export const ChatItem = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(["me", "bot", "note"]), text: z.string() }),
  ChatAction,
]);

export const Conversation = z.strictObject({ conversation: z.number(), items: z.array(ChatItem) });

export const AssistantState = z.strictObject({
  conversation: z.number(), items: z.array(ChatItem), questions: z.array(Question), cash: Cash, ai: z.boolean(),
});

/** One server-sent event of POST /api/assistant/chat/stream: text, status, then done (or error). */
export const ChatEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("status"), text: z.string() }),
  z.strictObject({ type: z.literal("error"), text: z.string() }),
  z.strictObject({ type: z.literal("done"), conversation: z.number(), items: z.array(ChatItem) }),
]);

/** Claude's guess for a payee, kept once made. */
export const SortGuess = z.strictObject({ category: z.string(), reason: z.string(), at: z.string() });

export const SortItem = z.strictObject({
  service: z.string(), tx_id: z.string(), date: z.string(), days_ago: z.number(), amount: z.number(), count: z.number(), total: z.number(),
  how: z.string(), shop: z.string().nullable(), description: z.string(),
  same_day: z.array(z.strictObject({ name: z.string(), amount: z.number(), category: z.string() })),
  history: z.array(z.strictObject({ date: z.string(), amount: z.number() })),
  guess: SortGuess.nullable(),
});

export const Sorter = z.strictObject({ items: z.array(SortItem), ai: z.boolean() });

export const Finding = z.strictObject({ title: z.string(), detail: z.string(), amount: z.number(), unit: z.string(), category: z.string() });

export const WeeklyRead = z.strictObject({
  headline: z.string(), findings: z.array(Finding), actions: z.array(z.strictObject({ text: z.string(), saves_monthly: z.number() })),
  body: z.string(), created_at: z.string(), model: z.string(), budgets: z.record(z.string(), z.number()).nullable(),
});

/** Claude's read of one spending period. */
export const Explanation = z.strictObject({ headline: z.string(), points: z.array(z.string()), try: z.string(), created_at: z.string() });

const Moved = z.strictObject({ moved: z.number() });

export const schemas = { ChatAction, ChatItem, Conversation, AssistantState, ChatEvent, SortGuess, SortItem, Sorter, Finding, WeeklyRead, Explanation };

export const responses = {
  "GET /api/assistant": AssistantState,
  "POST /api/assistant/chat": Conversation,
  "POST /api/assistant/actions/:actionId/confirm": z.strictObject({ result: z.string(), conversation: z.number(), items: z.array(ChatItem) }),
  "POST /api/assistant/actions/:actionId/cancel": Conversation,
  "POST /api/assistant/new": Conversation,
  "POST /api/assistant/answer": z.strictObject({ moved: z.number(), questions: z.array(Question) }),
  "GET /api/sorter": Sorter,
  "POST /api/sorter/undo": Moved,
  "POST /api/sorter/guess": SortGuess,
};

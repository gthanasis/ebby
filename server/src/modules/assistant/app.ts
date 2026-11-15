/** What the assistant may reach through the app's own API (shared/api.ts): every screen's reads, and every change a
 * person makes on those screens. Left out: sign-in, keys, other people, notifications, bank syncs (banks limit how
 * often they're fetched) and the routes that themselves call Claude. test/assistant_app.test.ts holds every route to
 * one of these lists, so a new one has to be placed. */

import { routeMatcher } from "../../shared/api.js";

export const READS = [
  "GET /api/home", "GET /api/me", "GET /api/status", "GET /api/categories", "GET /api/banks",
  "GET /api/spending", "GET /api/spending/category", "GET /api/category/:category", "GET /api/service", "GET /api/subscriptions",
  "GET /api/transactions", "GET /api/payment", "GET /api/overview", "GET /api/pace", "GET /api/year", "GET /api/kept",
  "GET /api/plan", "GET /api/fixed", "GET /api/commitments", "GET /api/commitments/services",
  "GET /api/goals", "GET /api/goals/overview", "GET /api/habits", "GET /api/habits/weekly", "GET /api/habits/rules/:hid",
  "GET /api/sorter", "GET /api/assistant/memory",
];

export const WRITES = [
  "POST /api/goals", "PATCH /api/goals/:goalId", "DELETE /api/goals/:goalId",
  "POST /api/commitments", "PUT /api/commitments/:cid", "DELETE /api/commitments/:cid",
  "POST /api/habits/rules", "PATCH /api/habits/rules/:hid", "DELETE /api/habits/rules/:hid", "PUT /api/habits/savings-accounts",
  "POST /api/wishlist", "POST /api/wishlist/:wid/decide", "POST /api/yearly", "DELETE /api/yearly/:yid",
  "PUT /api/payment/commitment", "PUT /api/transactions/:txId{.+}/category", "PUT /api/transactions/:txId{.+}/payee",
  "POST /api/service/move", "POST /api/sorter/undo", "POST /api/assistant/answer",
  "PUT /api/plan", "PUT /api/plan/limit", "PUT /api/settings",
  "POST /api/assistant/memory", "PUT /api/assistant/memory/:id", "DELETE /api/assistant/memory/:id",
];

/** Routes deliberately out of reach, so the test can tell a forgotten route from a refused one. */
export const OUT_OF_REACH = [
  "GET /api/people", "GET /api/push/key", "GET /api/assistant",
  "POST /api/credentials/enable-banking", "POST /api/credentials/anthropic", "DELETE /api/credentials/:kind",
  "POST /api/onboarding/done", "POST /api/people", "PATCH /api/people/:userId",
  "POST /api/push/subscribe", "POST /api/push/unsubscribe", "POST /api/push/test",
  "POST /api/assistant/chat", "POST /api/assistant/chat/stream", "POST /api/assistant/actions/:actionId/confirm",
  "POST /api/assistant/actions/:actionId/cancel", "POST /api/assistant/new", "POST /api/sorter/guess",
  "POST /api/spending/explain", "POST /api/insights/refresh", "POST /api/plan/suggest",
  "POST /api/sync", "POST /api/sync/live", "POST /api/auth/start", "POST /api/auth/complete",
];

const reads = READS.map(routeMatcher);
const writes = WRITES.map(routeMatcher);

export const canRead = (path: string) => path.startsWith("/api/") && reads.some((m) => m("GET", path));
export const canChange = (method: string, path: string) => path.startsWith("/api/") && writes.some((m) => m(method, path));

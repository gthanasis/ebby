// Every read endpoint, on the demo person's six months, returns exactly what the snapshot says: the contract.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { responses } from "../../src/contract.js";
import { contractApp, diff } from "./contract.js";

const SNAPSHOTS = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

// Each read worth pinning, with the parameters that change what it computes. {service}, {habit} and {account} are
// and {payment} are filled from the demo data, so the snapshots don't depend on ids.
const READS = [
  "/api/me", "/api/status", "/api/people", "/api/categories",
  "/api/home",
  "/api/spending", "/api/spending?range=day", "/api/spending?range=week", "/api/spending?range=year",
  "/api/spending?range=month&off=-1",
  "/api/spending/category?category=groceries", "/api/spending/category?category=eating_out&range=week",
  "/api/pace", "/api/pace?month=2026-09",
  "/api/category/groceries", "/api/category/delivery?month=2026-09",
  "/api/service?category=groceries&name={service}",
  "/api/subscriptions", "/api/year", "/api/year?year=2025",
  "/api/overview", "/api/overview?month=2026-09",
  "/api/transactions", "/api/transactions?category=groceries", "/api/transactions?account={account}&limit=20",
  "/api/transactions?q=wolt", "/api/transactions?limit=5&offset=5",
  "/api/plan", "/api/goals", "/api/goals/overview",
  "/api/commitments", "/api/commitments/services", "/api/commitments/services?transfers=true",
  "/api/habits", "/api/habits/weekly", "/api/habits/rules/{habit}",
  "/api/assistant", "/api/sorter", "/api/assistant/memory",
  "/api/fixed", "/api/fixed?month=2026-09", "/api/payment?id={payment}",
];
// Reads with no snapshot, and why.
// Routes with no JSON body to describe: the chat stream sends ChatEvent lines (assistant/schemas.ts).
const NO_BODY = new Set(["/api/healthz", "/api/assistant/chat/stream"]);
const SKIPPED: Record<string, string> = { "/api/banks": "asks Enable Banking", "/api/push/key": "a key made per install", "/api/healthz": "no data" };

const fileName = (path: string) => `${path.replace(/^\/api\//, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}.json`;

let api: Awaited<ReturnType<typeof contractApp>>;
beforeAll(async () => { api = await contractApp("ebby_ts_api_reads"); });
afterAll(() => api.teardown());

async function fill(path: string): Promise<string> {
  if (path.includes("{service}")) path = path.replace("{service}", encodeURIComponent((await api.json("/api/category/groceries")).services[0].name));
  if (path.includes("{account}")) path = path.replace("{account}", (await api.json("/api/status")).accounts[0].id);
  if (path.includes("{payment}")) path = path.replace("{payment}", encodeURIComponent((await api.json("/api/spending")).payments[0].id));
  if (path.includes("{habit}")) path = path.replace("{habit}", String((await api.json("/api/habits/weekly")).habits[0].id));
  return path;
}

describe("every read matches its snapshot", () => {
  it.each(READS)("%s", async (path) => {
    const url = await fill(path);
    const res = await api.request(url);
    const got = { status: res.status, body: await res.json() };
    const file = join(SNAPSHOTS, fileName(path));
    if (process.env.UPDATE_SNAPSHOTS || !existsSync(file)) {
      mkdirSync(SNAPSHOTS, { recursive: true });
      writeFileSync(file, `${JSON.stringify(sortKeys(got), null, 1)}\n`);
      if (!process.env.UPDATE_SNAPSHOTS) throw new Error(`new snapshot ${fileName(path)}: review it, then run again`);
      return;
    }
    const want = JSON.parse(readFileSync(file, "utf8"));
    expect(res.status, `${url}: status`).toBe(want.status);
    expect(diff(want.body, got.body), url).toBeNull();
    const schema = responseSchema(url);
    if (schema) {
      const parsed = schema.safeParse(got.body);
      expect(parsed.success ? null : parsed.error.issues.slice(0, 3), `${url}: its response schema`).toBeNull();
    }
  });

  it("every route declares what it returns (src/modules/*/schemas.ts)", () => {
    const missing = new Set<string>();
    for (const route of api.app.routes) {
      if (route.method === "ALL" || !route.path.startsWith("/api/") || NO_BODY.has(route.path)) continue;
      if (!responses[`${route.method} ${route.path}`]) missing.add(`${route.method} ${route.path}`);
    }
    expect([...missing]).toEqual([]);
    const routes = new Set(api.app.routes.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(responses).filter((k) => !routes.has(k)), "schemas for routes that don't exist").toEqual([]);
  });

  it("a new GET route gets a snapshot here, or a reason it can't have one", () => {
    const covered = READS.map((p) => p.split("?")[0]);
    for (const route of api.app.routes) {
      if (route.method !== "GET" || !route.path.startsWith("/api/") || route.path in SKIPPED) continue;
      const pattern = new RegExp(`^${route.path.replace(/:\w+(\{[^}]*\})?/g, "[^/]+")}$`);
      expect(covered.some((c) => pattern.test(c)), `${route.path} has no snapshot in READS`).toBe(true);
    }
  });
});

/** The declared response of the route a URL hits (GET), if there is one. */
function responseSchema(url: string) {
  const path = url.split("?")[0];
  const route = api.app.routes.find((r) => r.method === "GET" && new RegExp(`^${r.path.replace(/:\w+(\{[^}]*\})?/g, "[^/]+")}$`).test(path));
  return route ? responses[`GET ${route.path}`] : undefined;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

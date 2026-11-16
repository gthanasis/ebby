// The assistant reaches the app through its own routes (shared/api.ts): every route is placed in what it may read,
// what it may change, or what's out of reach; rehearsing a change never makes it; and it acts only as the person
// it's talking to.
import type { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { canChange, canRead, OUT_OF_REACH, READS, WRITES } from "../src/modules/assistant/app.js";
import { propose, runAction } from "../src/modules/assistant/service.js";
import * as api from "../src/shared/api.js";
import * as db from "../src/shared/db.js";
import { withPayCalendar } from "../src/shared/months.js";
import { createApp } from "../src/server.js";
import { users } from "./fixtures.js";

let app: Hono, ids: { a: number; b: number };
const as = <T>(user: number, fn: () => Promise<T>) => db.asUser(user, () => withPayCalendar(fn));

beforeAll(async () => {
  ids = await users();
  app = createApp();
});

describe("what the assistant can reach", () => {
  it("places every route", () => {
    const placed = new Set([...READS, ...WRITES, ...OUT_OF_REACH]);
    expect(placed.size).toBe(READS.length + WRITES.length + OUT_OF_REACH.length);  // none listed twice
    const routes = [...new Set(app.routes.filter((r) => r.path.startsWith("/api/") && r.method !== "ALL").map((r) => `${r.method} ${r.path}`))];
    const unplaced = routes.filter((r) => !placed.has(r) && r !== "GET /api/healthz");
    expect(unplaced).toEqual([]);
    expect([...placed].filter((r) => !routes.includes(r))).toEqual([]);  // nothing listed that isn't a route
  });

  it("reads and changes only what's listed", () => {
    expect(canRead("/api/fixed?month=2026-11")).toBe(true);
    expect(canRead("/api/people")).toBe(false);
    expect(canChange("DELETE", "/api/commitments/9")).toBe(true);
    expect(canChange("PUT", "/api/transactions/acc-AAA%3A0/category")).toBe(true);
    expect(canChange("POST", "/api/sync")).toBe(false);
    expect(canChange("GET", "/api/commitments/9")).toBe(false);
  });

  it("every change but a delete describes its body without running", async () => {
    const sample = (path: string) => path.replace(/:(\w+)(\{[^}]*\})?/g, "1");
    for (const route of WRITES.filter((r) => !r.startsWith("DELETE"))) {
      const [method, path] = route.split(" ");
      const { status, data } = await as(ids.a, () => api.call(method, sample(path), undefined, "describe"));
      expect([route, status, typeof (data as any)?.rehearsed?.schema]).toEqual([route, 200, "object"]);
    }
  });

  it("checking a change leaves things as they were, and a wrong body comes back at once", async () => {
    const before = await as(ids.a, () => api.call("GET", "/api/commitments"));
    const cost = (before.data as any).items[0];
    const body = { name: "Renamed", kind: "fixed", monthly_limit: 75, services: [], off_bank: 10 };
    const checked = await as(ids.a, () => api.call("PUT", `/api/commitments/${cost.id}`, body, "check"));
    expect((checked.data as any).rehearsed.body).toMatchObject({ name: "Renamed", monthly_limit: 75 });
    expect((await as(ids.a, () => api.call("GET", "/api/commitments"))).data).toEqual(before.data);
    const wrong = await as(ids.a, () => api.call("PUT", `/api/commitments/${cost.id}`, { name: 3 }, "check"));
    expect(wrong.status).toBe(422);
  });

  it("acts as the person it's talking to, and nobody else", async () => {
    const names = async (user: number) => ((await as(user, () => api.call("GET", "/api/commitments"))).data as any).items.map((c: any) => c.name);
    expect(await names(ids.a)).toContain("Commitment AAA");
    expect(await names(ids.a)).not.toContain("Commitment BBB");
    expect(await names(ids.b)).toEqual(["Commitment BBB"]);
    expect((await api.call("GET", "/api/commitments")).status).toBe(500);  // no person, no data
  });

  it("a drafted change runs only when confirmed", async () => {
    const list = async () => ((await as(ids.b, () => api.call("GET", "/api/commitments"))).data as any).items.filter((c: any) => c.name !== "Commitment BBB");
    await as(ids.b, () => api.call("POST", "/api/commitments", { name: "Gym B", kind: "fixed", monthly_limit: 20, off_bank: 20 }));
    const cost = (await list())[0];
    const draft = (args: Record<string, unknown>) => as(ids.b, () => db.connect((conn) => propose(conn, 1, "propose_change", { summary: "Change it", ...args })));
    expect((await draft({ method: "POST", path: "/api/sync", body_json: null })).error).toMatch(/isn't a change/);
    expect((await draft({ method: "PUT", path: `/api/commitments/${cost.id}`, body_json: "{\"name\": 3}" })).error).toMatch(/refused/);
    const body = { name: "Gym", kind: "fixed", monthly_limit: 30, services: [], off_bank: 30 };
    const drafted = await draft({ method: "PUT", path: `/api/commitments/${cost.id}`, body_json: JSON.stringify(body) });
    expect(drafted.action_id).toBeTypeOf("number");
    expect((await list())[0].name).toBe(cost.name);
    expect(await as(ids.b, () => runAction(drafted.action_id))).toBe("Done.");
    expect((await list())[0]).toMatchObject({ id: cost.id, name: "Gym", monthly_limit: 30 });
    const removed = await draft({ method: "DELETE", path: `/api/commitments/${cost.id}`, body_json: null });
    await as(ids.b, () => runAction(removed.action_id));
    expect(await list()).toEqual([]);
  });
});

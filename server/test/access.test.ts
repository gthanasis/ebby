// Signing in and keeping people apart: a session acts as its person, never sees another's data, and writes only from
// the app itself. The admin alone manages people.
import { randomBytes } from "node:crypto";

import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashToken } from "../src/api/auth.js";
import * as db from "../src/data/db.js";
import { ensureUser } from "../src/data/users.js";
import * as people from "../src/data/users.js";
import { createApp } from "../src/server.js";
import { users } from "./fixtures.js";

let app: Hono, ids: { a: number; b: number };
const ORIGIN = { Origin: "http://localhost" };  // a browser on the app itself
const store = new people.Store();

async function sessionFor(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await store.createSession(userId, hashToken(token), new Date(Date.now() + 86_400_000), "test");
  return token;
}

/** A client whose requests carry that session's cookie. */
const as = (token: string | null) => (path: string, init: RequestInit = {}) =>
  app.request(`http://localhost${path}`, { ...init, headers: { Host: "localhost", ...(token ? { Cookie: `session=${token}` } : {}), ...(init.headers as Record<string, string>) } });

beforeAll(async () => {
  ids = await users();
  process.env.GOOGLE_CLIENT_ID = "test-client";  // sign-in on
  app = createApp();
});
afterAll(() => { process.env.GOOGLE_CLIENT_ID = ""; });

/** Every GET route under /api, with sample values in its parameters. */
function getRoutes(): string[] {
  const values: Record<string, string> = { category: "delivery", txId: "acc-AAA:0", cid: "1", hid: "1", goalId: "1", wid: "1", yid: "1", userId: "1", actionId: "1", kind: "anthropic" };
  return app.routes.filter((r) => r.method === "GET" && r.path.startsWith("/api/"))
    .map((r) => r.path.replace(/:(\w+)(\{[^}]*\})?/g, (_, n) => values[n] ?? "x"));
}

describe("signing in", () => {
  it("the API needs a session; the app shell doesn't", async () => {
    expect((await as(null)("/api/status")).status).toBe(401);
    expect((await as(null)("/api/healthz")).status).toBe(200);
    expect((await as("not-a-session")("/api/me")).status).toBe(401);
  });

  it("a session acts as its person", async () => {
    const text = await (await as(await sessionFor(ids.b))("/api/transactions")).text();
    expect(text).toContain("Shop BBB");
    expect(text).not.toContain("AAA");
  });

  it("writes must come from the app's own pages", async () => {
    const b = as(await sessionFor(ids.b));
    const put = (headers: Record<string, string>) => b("/api/settings", { method: "PUT", body: JSON.stringify({ alerts: true }), headers: { "Content-Type": "application/json", ...headers } });
    expect((await put({})).status).toBe(403);
    expect((await put({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await put(ORIGIN)).status).toBe(200);
  });

  it("disabling someone signs them out at once", async () => {
    const c = await ensureUser("c@example.com");
    const client = as(await sessionFor(c));
    expect((await client("/api/me")).status).toBe(200);
    await people.update(c, { status: "disabled" });
    expect((await client("/api/me")).status).toBe(401);
  });

  it("me says what setup is left", async () => {
    const me = await (await as(await sessionFor(ids.b))("/api/me")).json();
    expect(me.email).toBe("b@example.com");
    expect(me.onboarding).toEqual({ bank_access: false, banks_connected: 1, done: false });
  });

  it("only the admin manages people", async () => {
    expect((await as(await sessionFor(ids.b))("/api/people")).status).toBe(403);
    const list = await (await as(await sessionFor(ids.a))("/api/people")).json();
    expect(list.map((p: any) => p.email)).toContain("b@example.com");
  });

  it("a public install with no sign-in refuses rather than act as the admin", async () => {
    process.env.GOOGLE_CLIENT_ID = ""; process.env.PUBLIC_URL = "https://spending.example.com";
    try {
      expect((await createApp().request("http://localhost/api/status")).status).toBe(503);
    } finally {
      process.env.GOOGLE_CLIENT_ID = "test-client"; process.env.PUBLIC_URL = "http://localhost:8000";
    }
  });
});

describe("keeping people apart", () => {
  it("no GET route shows another person's data", async () => {
    const b = as(await sessionFor(ids.b));
    const routes = getRoutes();
    expect(routes.length).toBeGreaterThan(20);  // the route list really was walked
    for (const path of routes) {
      const text = await (await b(path)).text();
      expect(text, `${path} shows user A's data to user B`).not.toContain("AAA");
    }
  });

  it("your own data still shows", async () => {
    const b = as(await sessionFor(ids.b));
    expect(await (await b("/api/goals")).text()).toContain("Goal BBB");
    expect(await (await b("/api/commitments")).text()).toContain("Commitment BBB");
  });

  it("nobody can move another person's payment", async () => {
    const res = await as(await sessionFor(ids.b))("/api/transactions/acc-AAA:0/category",
      { method: "PUT", body: JSON.stringify({ category: "eating_out" }), headers: { "Content-Type": "application/json", ...ORIGIN } });
    expect(res.status).toBe(404);
    const category = await db.asUser(ids.a, () => db.connect(async (c) => (await c.execute("SELECT category FROM transactions WHERE id = 'acc-AAA:0'")).one()!.category));
    expect(category).toBe("groceries");
  });

  it("without a person, the database refuses", async () => {
    await expect(db.connect(async () => 1)).rejects.toThrow(db.NoUser);
  });

  it("the app's role, acting for nobody, sees and writes nothing of anyone's", async () => {
    await db.connectSystem(async (conn) => {
      expect((await conn.execute("SELECT COUNT(*) AS n FROM transactions")).one()!.n).toBe(0);
      await expect(conn.execute("INSERT INTO rules(merchant, category) VALUES('x', 'y')")).rejects.toThrow();
    });
  });

  it("nobody can write into another person's rows", async () => {
    await expect(db.asUser(ids.b, () => db.connect((conn) =>
      conn.execute("INSERT INTO rules(user_id, merchant, category) VALUES(?, 'sneaky', 'x')", [ids.a])))).rejects.toThrow();
  });

  it("a pooled connection forgets whose it was", async () => {
    await db.asUser(ids.a, () => db.connect(async () => undefined));
    await db.connectSystem(async (conn) => expect((await conn.execute("SELECT COUNT(*) AS n FROM goals")).one()!.n).toBe(0));
  });

  it("background work keeps acting as the person who started it", async () => {
    const seen = await db.asUser(ids.b, () => new Promise<string>((resolve) => {
      setTimeout(() => db.connect(async (c) => resolve((await c.execute("SELECT name FROM goals")).one()!.name)), 5);
    }));
    expect(seen).toBe("Goal BBB");
  });
});

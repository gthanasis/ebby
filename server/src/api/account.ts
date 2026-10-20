/** Who's signed in, their keys, first-run setup, and the admin's people. */

import type { Hono } from "hono";
import { z } from "zod";

import { config } from "../config.js";
import * as credentials from "../integrations/credentials.js";
import * as db from "../data/db.js";
import * as aiUsageRepo from "../data/repos/ai_usage.js";
import type { Conn } from "../data/db.js";
import * as users from "../data/users.js";
import * as vault from "../data/vault.js";
import * as aiUsage from "../domain/ai_usage.js";
import { pyRound } from "../py.js";
import { body, fail, HttpError, int, num } from "./http.js";
import { localToday } from "../domain/months.js";

async function onboarding(conn: Conn) {
  const keys = await credentials.publicInfo(conn);
  const connected = (await db.connections(conn)).filter((c) => c.session_id).length;
  return { bank_access: "enable_banking" in keys, banks_connected: connected, done: Boolean(await db.getMeta(conn, "onboarded")) };
}

async function admin() {
  if (!(await users.me(db.currentUser()!)).is_admin) fail(403, "Only the admin can manage people.");
}

const monthStart = () => aiUsage.monthBounds(localToday())[0];
const budget = num.refine((v) => v >= 0 && v <= 1000, "Input should be between 0 and 1000").nullable().optional();

export function routes(app: Hono) {
  app.get("/api/me", async (c) => {
    const person = await users.me(db.currentUser()!);
    const since = monthStart();
    const [keys, ob, spent] = await db.connect(async (conn) => [
      await credentials.publicInfo(conn), await onboarding(conn),
      // What counts against the allowance: calls on the owner's key this month.
      await aiUsageRepo.spentOnOwnerKey(conn, since),
    ] as const);
    return c.json({
      email: person.email, name: person.name, picture: person.picture, is_admin: person.is_admin,
      ai_budget_usd: person.ai_budget_usd, ai_spent_usd: pyRound(spent, 2), credentials: keys, onboarding: ob,
      // What each person allows on their own Enable Banking app, so banks can send them back here.
      eb_redirect_url: config.REDIRECT_URL,
    });
  });

  app.post("/api/credentials/enable-banking", async (c) => {
    const form = await c.req.parseBody();
    const appId = form.app_id, pem = form.pem;
    if (typeof appId !== "string" || !(pem instanceof File)) throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required" }]);
    const data = Buffer.from(await pem.slice(0, vault.MAX_PEM_BYTES + 1).arrayBuffer());
    try {
      return c.json(await credentials.saveEnableBanking(appId, data));
    } catch (e) {
      if (e instanceof Error && !(e instanceof HttpError)) return fail(400, e.message);
      throw e;
    }
  });

  app.post("/api/credentials/anthropic", async (c) => {
    const b = await body(c, z.object({ api_key: z.string().min(10).max(400) }));
    try {
      return c.json(await credentials.saveAnthropic(b.api_key));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  });

  app.delete("/api/credentials/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "enable_banking" && kind !== "anthropic") throw new HttpError(422, [{ type: "literal_error", loc: ["path", "kind"], msg: "Input should be 'enable_banking' or 'anthropic'" }]);
    await credentials.remove(kind);
    return c.body(null, 204);
  });

  app.post("/api/onboarding/done", async (c) => {
    await db.connect(async (conn) => {
      if (!(await onboarding(conn)).banks_connected) fail(400, "Connect at least one bank first.");
      await db.setMeta(conn, "onboarded", true);
    });
    return c.body(null, 204);
  });

  app.get("/api/people", async (c) => {
    await admin();
    return c.json(await users.people(monthStart()));
  });

  app.post("/api/people", async (c) => {
    await admin();
    const b = await body(c, z.object({ email: z.string().max(200), ai_budget_usd: budget }));
    try {
      return c.json(await users.invite(b.email, b.ai_budget_usd ?? null));
    } catch (e) {
      return fail(400, (e as Error).message);
    }
  });

  app.patch("/api/people/:userId", async (c) => {
    await admin();
    const userId = int(c.req.param("userId"), "user_id", 0);
    const b = await body(c, z.object({ status: z.enum(["active", "disabled"]).nullable().optional(), ai_budget_usd: budget }));
    await users.update(userId, { status: b.status ?? null, aiBudgetUsd: b.ai_budget_usd ?? null });
    return c.json(await users.people(monthStart()));
  });
}

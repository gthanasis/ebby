/** Who's signed in, their keys, first-run setup, and the admin's people. */

import type { Hono } from "hono";
import { z } from "zod";

import { config } from "../../config.js";
import * as credentials from "../banks/credentials.js";
import * as db from "../../shared/db.js";
import * as aiUsageRepo from "../assistant/ai_usage_repo.js";
import type { Conn } from "../../shared/db.js";
import * as users from "./repo.js";
import { toMe, toOnboarding, toPerson } from "./converters.js";
import * as vault from "../../shared/vault.js";
import * as aiUsage from "../assistant/ai_usage.js";
import { body, fail, HttpError, int, mapErrors, num } from "../../shared/http.js";
import { localToday } from "../../shared/months.js";

async function onboarding(conn: Conn) {
  const keys = await credentials.publicInfo(conn);
  const connected = (await db.connections(conn)).filter((c) => c.session_id).length;
  return toOnboarding(keys, connected, await db.getMeta(conn, "onboarded"));
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
    // What each person allows on their own Enable Banking app, so banks can send them back here.
    return c.json(toMe(person, spent, keys, ob, config.REDIRECT_URL));
  });

  app.post("/api/credentials/enable-banking", async (c) => {
    const form = await c.req.parseBody();
    const appId = form.app_id, pem = form.pem;
    if (typeof appId !== "string" || !(pem instanceof File)) throw new HttpError(422, [{ type: "missing", loc: ["body"], msg: "Field required" }]);
    const data = Buffer.from(await pem.slice(0, vault.MAX_PEM_BYTES + 1).arrayBuffer());
    return mapErrors(async () => c.json(await credentials.saveEnableBanking(appId, data)), [[HttpError, "pass"], [Error, 400]]);
  });

  app.post("/api/credentials/anthropic", async (c) => {
    const b = await body(c, z.object({ api_key: z.string().min(10).max(400) }));
    return mapErrors(async () => c.json(await credentials.saveAnthropic(b.api_key)), [["*", 400, (e) => e.message]]);
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
    return c.json((await users.people(monthStart())).map(toPerson));
  });

  app.post("/api/people", async (c) => {
    await admin();
    const b = await body(c, z.object({ email: z.string().max(200), ai_budget_usd: budget }));
    return mapErrors(async () => c.json(await users.invite(b.email, b.ai_budget_usd ?? null)), [["*", 400, (e) => e.message]]);
  });

  app.patch("/api/people/:userId", async (c) => {
    await admin();
    const userId = int(c.req.param("userId"), "user_id", 0);
    const b = await body(c, z.object({ status: z.enum(["active", "disabled"]).nullable().optional(), ai_budget_usd: budget }));
    await users.update(userId, { status: b.status ?? null, aiBudgetUsd: b.ai_budget_usd ?? null });
    return c.json((await users.people(monthStart())).map(toPerson));
  });
}

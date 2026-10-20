/** Web push: the key, subscribing, a test notification. */

import type { Hono } from "hono";
import { z } from "zod";

import * as push from "../integrations/push.js";
import { body, num } from "./http.js";

export function routes(app: Hono) {
  app.get("/api/push/key", (c) => c.json({ key: push.publicKey() }));

  app.post("/api/push/subscribe", async (c) => {
    const b = await body(c, z.object({ endpoint: z.string(), keys: z.record(z.string(), z.string()), expirationTime: num.nullable().default(null) }));
    await push.subscribe(b);
    return c.json({ devices: await push.count() });
  });

  app.post("/api/push/unsubscribe", async (c) => {
    const b = await body(c, z.object({ endpoint: z.string() }));
    await push.unsubscribe(b.endpoint);
    return c.json({ devices: await push.count() });
  });

  app.post("/api/push/test", async (c) => c.json({ sent: await push.send("Notifications are on", "This is how cool-down alerts will reach you.", "/#/plan", "test") }));
}

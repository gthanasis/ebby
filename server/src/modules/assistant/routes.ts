/** The assistant's chat, its proposed actions, and the payment sorter. */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";

import * as db from "../../shared/db.js";
import * as ai from "./ai.js";
import * as assistant from "./service.js";
import { CATEGORIES } from "../../shared/categories.js";
import * as sorter from "./sorter.js";
import * as memory from "./memory.js";
import { pyDumps } from "../../shared/utils/python.js";
import { body, fail, int, mapErrors } from "../../shared/http.js";
import { cashView } from "../spending/cash.js";
import { clearServiceCategory, setServiceCategory } from "../banks/ingest.js";
import { questions } from "../spending/questions.js";
import { thisMonth } from "../../shared/months.js";

const ChatIn = z.object({ text: z.string() });

export function routes(app: Hono) {
  app.get("/api/assistant", async (c) => {
    const [qs, cash] = await db.connect(async (conn) => [await questions(conn), await cashView(conn, thisMonth())] as const);
    return c.json({ ...(await assistant.display()), questions: qs, cash, ai: await ai.available() });
  });

  app.post("/api/assistant/chat", async (c) => {
    const b = await body(c, ChatIn);
    if (!b.text.trim()) fail(400, "Say something first");
    return mapErrors(async () => c.json(await assistant.chat(b.text.trim().slice(0, 2000))), [["*", 503]]);
  });

  /** The reply as it's written, as server-sent events: text, status, then done (or error). */
  app.post("/api/assistant/chat/stream", async (c) => {
    const b = await body(c, ChatIn);
    if (!b.text.trim()) fail(400, "Say something first");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      for await (const event of assistant.chatEvents(b.text.trim().slice(0, 2000))) {
        await stream.writeSSE({ data: pyDumps(event, { ensureAscii: false }) });
      }
    });
  });

  app.post("/api/assistant/actions/:actionId/confirm", async (c) => {
    const id = int(c.req.param("actionId"), "action_id", 0);
    const result = await mapErrors(() => assistant.runAction(id), [["*", 400]]);
    return c.json({ result, ...(await assistant.display()) });
  });

  app.post("/api/assistant/actions/:actionId/cancel", async (c) => {
    await assistant.cancelAction(int(c.req.param("actionId"), "action_id", 0));
    return c.json(await assistant.display());
  });

  app.post("/api/assistant/new", async (c) => {
    await assistant.newConversation();
    return c.json(await assistant.display());
  });

  /** Answer to "what was this?" for a payee left in Other: all its payments, now and later. */
  app.post("/api/assistant/answer", async (c) => {
    const b = await body(c, z.object({ service: z.string(), category: z.string() }));
    if (!(b.category in CATEGORIES)) fail(400, "Unknown category");
    return c.json(await db.connect(async (conn) => ({ moved: await setServiceCategory(conn, b.service, b.category), questions: await questions(conn) })));
  });

  app.get("/api/sorter", async (c) => c.json({ items: await db.connect((conn) => sorter.items(conn)), ai: await ai.available() }));

  /** Take back an answer: the payee's rules go, so its payments are worked out as before. */
  app.post("/api/sorter/undo", async (c) => {
    const b = await body(c, z.object({ service: z.string() }));
    return c.json({ moved: await db.connect((conn) => clearServiceCategory(conn, b.service)) });
  });

  app.get("/api/assistant/memory", async (c) => c.json(await db.connect((conn) => memory.list(conn))));

  /** A line to remember; service when it came from a payment, so that payee's guess is made again with it. */
  app.post("/api/assistant/memory", async (c) => {
    const b = await body(c, z.object({ text: z.string(), service: z.string().nullable().default(null) }));
    return c.json(await db.connect((conn) => memory.remember(conn, b.text, b.service ? "payment" : "you", b.service)));
  });

  app.put("/api/assistant/memory/:id", async (c) => {
    const b = await body(c, z.object({ text: z.string() }));
    return c.json(await db.connect((conn) => memory.edit(conn, int(c.req.param("id"), "id", 0), b.text)));
  });

  app.delete("/api/assistant/memory/:id", async (c) =>
    c.json(await db.connect((conn) => memory.forget(conn, int(c.req.param("id"), "id", 0)))));

  app.post("/api/sorter/guess", async (c) => {
    const b = await body(c, z.object({ service: z.string() }));
    const g = await db.connect((conn) => sorter.guess(conn, b.service));
    if (!g) fail(502, "The assistant couldn't make a guess for this one.");
    return c.json(g);
  });
}

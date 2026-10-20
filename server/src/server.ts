/** Builds the app: the sign-in middleware, the routers, and the web app's files. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { Hono } from "hono";

import * as account from "./modules/account/routes.js";
import * as assistantRoutes from "./modules/assistant/routes.js";
import * as auth from "./modules/account/auth.js";
import { authenticator } from "./modules/account/authenticate.js";
import * as banksRoutes from "./modules/banks/routes.js";
import * as commitments from "./modules/commitments/routes.js";
import * as goals from "./modules/goals/routes.js";
import * as habitsRoutes from "./modules/habits/routes.js";
import { HttpError } from "./shared/http.js";
import * as plan from "./modules/plan/routes.js";
import * as pushRoutes from "./modules/alerts/routes.js";
import * as spendingRoutes from "./modules/spending/routes.js";
import * as transactions from "./modules/transactions/routes.js";
import { config } from "./config.js";
import * as db from "./shared/db.js";
import * as users from "./modules/account/repo.js";
import { withPayCalendar } from "./shared/months.js";

const PUBLIC_PATHS = new Set(["/api/healthz"]);
const store = new users.Store();

/** Data lives behind /api and the bank's redirect. The app shell and its assets carry none, so they load signed out
 * and show the login page. */
const isPrivate = (path: string) => (path.startsWith("/api/") && !PUBLIC_PATHS.has(path)) || path === "/eb-callback";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".mp4": "video/mp4",
};

export function createApp(): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    if (e instanceof HttpError) return c.json({ detail: e.detail }, e.status as any);
    console.error(`${c.req.method} ${c.req.path} failed:`, e);
    return c.text("Internal Server Error", 500);
  });

  const authenticate = authenticator(store);
  app.use("*", async (c, next) => {
    if (!isPrivate(c.req.path)) return next();
    const who = await authenticate(c);
    if (typeof who !== "number") return who;
    // Everything downstream (routes, their background work, streams) reads and writes as this user.
    return db.asUser(who, () => withPayCalendar(() => next()));
  });

  app.get("/api/healthz", (c) => c.json({ ok: true }));
  app.route("/", auth.router(store));
  for (const module of [account, transactions, banksRoutes, spendingRoutes, commitments, assistantRoutes, habitsRoutes, plan, goals, pushRoutes]) {
    module.routes(app);
  }

  if (existsSync(config.WEB_DIST)) {
    const root = resolve(config.WEB_DIST);
    app.get("*", (c) => {
      const path = decodeURIComponent(c.req.path.replace(/^\/+/, ""));
      const file = resolve(join(root, path));
      if (path && file.startsWith(root + "/") && existsSync(file) && statSync(file).isFile()) {
        // The service worker and manifest must be re-checked on every load to pick up new builds.
        const fresh = path === "sw.js" || path === "manifest.webmanifest";
        return c.body(readFileSync(file), 200, {
          "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
          ...(fresh ? { "Cache-Control": "no-cache" } : path.startsWith("assets/") ? {} : {}),
        });
      }
      return c.body(readFileSync(join(root, "index.html")), 200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache" });
    });
  }
  return app;
}

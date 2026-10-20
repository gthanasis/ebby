/** Builds the app: the sign-in middleware, the routers, and the web app's files. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import { Hono } from "hono";

import * as account from "./api/account.js";
import * as assistantRoutes from "./api/assistant.js";
import * as auth from "./api/auth.js";
import * as banksRoutes from "./api/banks.js";
import * as commitments from "./api/commitments.js";
import * as goals from "./api/goals.js";
import * as habitsRoutes from "./api/habits.js";
import { HttpError } from "./api/http.js";
import * as plan from "./api/plan.js";
import * as pushRoutes from "./api/push.js";
import * as spendingRoutes from "./api/spending.js";
import * as transactions from "./api/transactions.js";
import { config, secrets } from "./config.js";
import * as db from "./data/db.js";
import * as users from "./data/users.js";
import * as insights from "./domain/insights.js";

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

  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path) || !isPrivate(path)) return next();
    let userId: number | null;
    if (config.GOOGLE_CLIENT_ID) {
      const user = await auth.currentUser(c, store);
      if (!user) return c.json({ detail: "Sign in first." }, 401);
      if (!auth.originOk(c)) return c.json({ detail: "That request didn't come from this app." }, 403);
      userId = user.id;
    } else if (secrets.APP_PASSWORD) {
      const header = c.req.header("authorization") ?? "";
      let ok = false;
      if (header.startsWith("Basic ")) {
        const decoded = Buffer.from(header.slice(6), "base64").toString();
        ok = decoded.slice(decoded.indexOf(":") + 1) === secrets.APP_PASSWORD;
      }
      if (!ok) return c.body(null, 401, { "WWW-Authenticate": 'Basic realm="ebby"' });
      userId = await db.adminId();
    } else if (config.LOCAL) {
      userId = await db.adminId();  // local runs without any login act as the admin
    } else {
      // Public and no sign-in configured: acting as the admin would hand anyone their money.
      return c.text("No sign-in configured: set GOOGLE_CLIENT_ID (or APP_PASSWORD for a private install).", 503);
    }
    if (userId == null) return c.text("No users yet: set ADMIN_EMAIL or run `ebby add-user EMAIL --admin`.", 503);
    // Everything downstream (routes, their background work, streams) reads and writes as this user.
    return db.asUser(userId, async () => {
      await insights.loadPayday();
      await next();
    });
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

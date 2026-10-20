/** Settings from the environment (and .env next to the repo root, for local runs). */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

(function loadEnvFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) return;
  for (let line of readFileSync(file, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const key = line.slice(0, i).trim(), value = line.slice(i + 1).trim().replace(/^"+|"+$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

const env = (name: string, fallback = "") => process.env[name] ?? fallback;
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

// Read on every use, so tests can change them.
export const config = {
  get DATA_DIR() { return expand(env("DATA_DIR", join(ROOT, "data"))); },
  // Postgres. The app connects as a role that owns nothing, so row-level security always applies to it; the
  // owner URL runs migrations and creates that role (with the password in DATABASE_URL) if it's missing.
  get DATABASE_URL() { return env("DATABASE_URL"); },
  get DATABASE_OWNER_URL() { return env("DATABASE_OWNER_URL"); },
  get ADMIN_EMAIL() { return env("ADMIN_EMAIL").trim().toLowerCase(); },
  WEB_DIST: join(ROOT, "web", "dist"),
  MIGRATIONS: join(ROOT, "app", "data", "migrations"),

  get APP_ID() { return env("EB_APP_ID"); },
  get KEY_PATH() { return expand(env("EB_KEY_PATH", join(this.DATA_DIR, "key.pem"))); },
  get REDIRECT_URL() { return env("EB_REDIRECT_URL", "https://localhost/eb-callback"); },
  get COUNTRY() { return env("EB_COUNTRY", "GR"); },
  get CONSENT_DAYS() { return parseInt(env("EB_CONSENT_DAYS", "180"), 10); },

  get SYNC_HOURS() { return parseFloat(env("SYNC_HOURS", "6")); },
  get SYNC_LOOKBACK_DAYS() { return parseInt(env("SYNC_LOOKBACK_DAYS", "14"), 10); },
  // Optional: protects the dashboard with HTTP basic auth (any username). For local/LAN use.
  get APP_PASSWORD() { return env("APP_PASSWORD"); },
  // Google sign-in. Set, it's how requests find their user. Unset, only a local run (PUBLIC_URL on localhost)
  // serves data, as the admin; anywhere else the app refuses rather than hand the admin's money to anyone.
  get GOOGLE_CLIENT_ID() { return env("GOOGLE_CLIENT_ID"); },
  get GOOGLE_CLIENT_SECRET() { return env("GOOGLE_CLIENT_SECRET"); },
  get SESSION_SECRET() { return env("SESSION_SECRET"); },
  get PUBLIC_URL() { return env("PUBLIC_URL", "http://localhost:8000").replace(/\/+$/, ""); },
  get LOCAL() { return this.PUBLIC_URL.startsWith("http://localhost"); },
  get DEMO() { return env("DEMO") === "1"; },

  get VAPID_PRIVATE_KEY() { return env("VAPID_PRIVATE_KEY"); },
  get VAPID_SUBJECT() { return env("VAPID_SUBJECT") || this.PUBLIC_URL; },
  get TIMEZONE() { return env("TZ_NAME", "Europe/Athens"); },
  get ANTHROPIC_API_KEY() { return env("ANTHROPIC_API_KEY"); },
  get ANTHROPIC_WORKSPACE_ID() { return env("ANTHROPIC_WORKSPACE_ID"); },
  get ANTHROPIC_MODEL() { return env("ANTHROPIC_MODEL", "claude-opus-5-5"); },
  // The chat and the sorter's guesses run often and need little: the cheapest model unless Settings says otherwise.
  get ASSISTANT_MODEL() { return env("ASSISTANT_MODEL", "claude-haiku-5-5"); },
  ASSISTANT_MODELS: { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" } as Record<string, string>,
  get PORT() { return parseInt(env("PORT", "8000"), 10); },
};

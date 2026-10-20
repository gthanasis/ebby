/**
 * Settings from the environment (and .env at the repo root, for local runs): the only module that reads process.env.
 *
 * Each variable has one rule. validateConfig() checks them all at startup and names every problem at once, so a
 * typo stops the server before it serves anything; the getters apply the same rules on each read, so tests can
 * change the environment as they go.
 *
 * `config` holds what tunes the app; `secrets` what must never be logged or sent anywhere.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

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

// ---------- the rules, by variable name ----------

const text = (fallback = "") => z.string().default(fallback);
const url = (fallback?: string) => z.string().default(fallback ?? "").refine((v) => !v || URL.canParse(v), "must be a URL");
const whole = (fallback: number, min: number, max: number) => z.string().default(String(fallback))
  .refine((v) => /^\d+$/.test(v.trim()) && +v >= min && +v <= max, `must be a whole number from ${min} to ${max}`).transform((v) => parseInt(v, 10));
const positive = (fallback: number) => z.string().default(String(fallback))
  .refine((v) => Number.isFinite(+v) && +v > 0, "must be a number above 0").transform(Number);
const key32 = z.string().default("").refine((v) => !v.trim() || Buffer.from(v.trim(), "base64").length === 32, "must be 32 bytes, base64 encoded");
const timeZone = text("Europe/Athens").refine((v) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } },
  "must be a time zone name such as Europe/Athens");

const RULES = {
  DATA_DIR: text(),
  // Postgres. The app connects as a role that owns nothing, so row-level security always applies to it; the owner
  // URL runs migrations and creates that role (with the password in DATABASE_URL) if it's missing.
  DATABASE_URL: url(),
  DATABASE_OWNER_URL: url(),
  ADMIN_EMAIL: text().refine((v) => !v || v.includes("@"), "must be an email address"),
  // Where the bank sends people back after they approve; also an allowed redirect on each Enable Banking app.
  EB_REDIRECT_URL: url("https://localhost/eb-callback"),
  EB_COUNTRY: text("GR").refine((v) => /^[A-Z]{2}$/.test(v), "must be a two-letter country code, e.g. GR"),
  EB_CONSENT_DAYS: whole(180, 1, 180),
  SYNC_HOURS: positive(6),
  SYNC_LOOKBACK_DAYS: whole(14, 1, 545),
  // Optional: protects the dashboard with HTTP basic auth (any username). For local/LAN use.
  APP_PASSWORD: text(),
  // Google sign-in. Set, it's how requests find their user. Unset, only a local run (PUBLIC_URL on localhost) serves
  // data, as the admin; anywhere else the app refuses rather than hand the admin's money to anyone.
  GOOGLE_CLIENT_ID: text(),
  GOOGLE_CLIENT_SECRET: text(),
  SESSION_SECRET: text(),
  PUBLIC_URL: url("http://localhost:8000"),
  DEMO: text().refine((v) => ["", "0", "1"].includes(v), "must be 1 or empty"),
  VAPID_PRIVATE_KEY: text().refine((v) => !v || v.includes("PRIVATE KEY"), "must be a PEM private key (newlines may be written \\n)"),
  VAPID_SUBJECT: text(),
  TZ_NAME: timeZone,
  ANTHROPIC_API_KEY: text(),
  ANTHROPIC_WORKSPACE_ID: text(),
  ANTHROPIC_MODEL: text("claude-opus-5-5"),
  // The chat and the sorter's guesses run often and need little: the cheapest model unless Settings says otherwise.
  ASSISTANT_MODEL: text("claude-haiku-5-5"),
  // Seals each person's keys (data/vault). Old keys still open what they sealed, so the main one can rotate.
  CREDENTIALS_KEY: key32,
  CREDENTIALS_OLD_KEYS: text().refine((v) => v.split(",").every((k) => !k.trim() || Buffer.from(k.trim(), "base64").length === 32),
    "must be base64 keys of 32 bytes, separated by commas"),
  PORT: whole(8000, 1, 65535),
  // Tests: pin the clock to a moment (an ISO time), and keep the background scheduler off.
  EBBY_NOW: text().refine((v) => !v || !Number.isNaN(Date.parse(v)), "must be an ISO date and time, e.g. 2026-10-20T09:00:00+03:00"),
  EBBY_SCHEDULER: text().refine((v) => ["", "on", "off"].includes(v), "must be on, off or empty"),
};
type Name = keyof typeof RULES;

export class ConfigError extends Error {}

/** One variable, by its rule; a bad value throws a ConfigError that names it. */
function read<N extends Name>(name: N): z.output<(typeof RULES)[N]> {
  const raw = process.env[name];
  const result = RULES[name].safeParse(raw === "" && name !== "DEMO" ? undefined : raw);
  if (!result.success) throw new ConfigError(`${name} ${result.error.issues[0].message}`);
  return result.data as z.output<(typeof RULES)[N]>;
}
const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Checks every variable, and the ones that only make sense together. Throws ConfigError naming each problem. */
export function validateConfig(needs: { database?: boolean } = {}) {
  const problems: string[] = [];
  for (const name of Object.keys(RULES) as Name[]) {
    const raw = process.env[name];
    const result = RULES[name].safeParse(raw === "" && name !== "DEMO" ? undefined : raw);
    if (!result.success) problems.push(`${name} ${result.error.issues[0].message}`);
  }
  const set = (name: Name) => Boolean(process.env[name]?.trim());
  if (needs.database && !set("DATABASE_URL")) problems.push("DATABASE_URL is required");
  if (set("GOOGLE_CLIENT_ID")) {
    for (const name of ["GOOGLE_CLIENT_SECRET", "SESSION_SECRET"] as const) if (!set(name)) problems.push(`${name} is required when GOOGLE_CLIENT_ID is set`);
  }
  if (problems.length) throw new ConfigError(`ebby can't start, its settings need fixing:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}

// ---------- what the app reads ----------

export const config = {
  get DATA_DIR() { return expand(read("DATA_DIR") || join(ROOT, "data")); },
  get DATABASE_URL() { return read("DATABASE_URL"); },
  get DATABASE_OWNER_URL() { return read("DATABASE_OWNER_URL"); },
  get ADMIN_EMAIL() { return read("ADMIN_EMAIL").trim().toLowerCase(); },
  WEB_DIST: join(ROOT, "web", "dist"),
  MIGRATIONS: join(ROOT, "server", "migrations"),

  get REDIRECT_URL() { return read("EB_REDIRECT_URL"); },
  get COUNTRY() { return read("EB_COUNTRY"); },
  get CONSENT_DAYS() { return read("EB_CONSENT_DAYS"); },
  get SYNC_HOURS() { return read("SYNC_HOURS"); },
  get SYNC_LOOKBACK_DAYS() { return read("SYNC_LOOKBACK_DAYS"); },

  get GOOGLE_CLIENT_ID() { return read("GOOGLE_CLIENT_ID"); },
  get PUBLIC_URL() { return read("PUBLIC_URL").replace(/\/+$/, ""); },
  get LOCAL() { return this.PUBLIC_URL.startsWith("http://localhost"); },
  get DEMO() { return read("DEMO") === "1"; },
  get VAPID_SUBJECT() { return read("VAPID_SUBJECT") || this.PUBLIC_URL; },
  get TIMEZONE() { return read("TZ_NAME"); },
  get ANTHROPIC_WORKSPACE_ID() { return read("ANTHROPIC_WORKSPACE_ID"); },
  get ANTHROPIC_MODEL() { return read("ANTHROPIC_MODEL"); },
  get ASSISTANT_MODEL() { return read("ASSISTANT_MODEL"); },
  get PORT() { return read("PORT"); },

  /** A pinned moment for tests (EBBY_NOW), or null for the real clock. */
  get NOW(): string | null { return read("EBBY_NOW") || null; },
  /** False when EBBY_SCHEDULER=off. */
  get SCHEDULER() { return read("EBBY_SCHEDULER") !== "off"; },
};

export const secrets = {
  get APP_PASSWORD() { return read("APP_PASSWORD"); },
  get GOOGLE_CLIENT_SECRET() { return read("GOOGLE_CLIENT_SECRET"); },
  get SESSION_SECRET() { return read("SESSION_SECRET"); },
  get VAPID_PRIVATE_KEY() { return read("VAPID_PRIVATE_KEY"); },
  get ANTHROPIC_API_KEY() { return read("ANTHROPIC_API_KEY"); },
  get CREDENTIALS_KEY() { return read("CREDENTIALS_KEY").trim(); },
  get CREDENTIALS_OLD_KEYS(): string[] { return read("CREDENTIALS_OLD_KEYS").split(",").map((k) => k.trim()).filter(Boolean); },
};

// The server checks its settings before it starts, and names every problem at once.
import { afterEach, describe, expect, it } from "vitest";

import { config, ConfigError, secrets, validateConfig } from "../src/config.js";

const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe("settings", () => {
  it("the test environment is valid", () => expect(() => validateConfig({ database: true })).not.toThrow());

  it("every problem is named at once", () => {
    Object.assign(process.env, { EB_CONSENT_DAYS: "365", TZ_NAME: "Athens", SYNC_HOURS: "0", EB_COUNTRY: "Greece" });
    let message = "";
    try { validateConfig(); } catch (e) { expect(e).toBeInstanceOf(ConfigError); message = (e as Error).message; }
    for (const name of ["EB_CONSENT_DAYS", "TZ_NAME", "SYNC_HOURS", "EB_COUNTRY"]) expect(message).toContain(name);
  });

  it("serving needs a database", () => {
    process.env.DATABASE_URL = "";
    expect(() => validateConfig({ database: true })).toThrow("DATABASE_URL is required");
    expect(() => validateConfig()).not.toThrow();  // commands that don't touch it can still run
  });

  it("Google sign-in needs its secret and a session secret", () => {
    Object.assign(process.env, { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "", SESSION_SECRET: "" });
    expect(() => validateConfig()).toThrow(/GOOGLE_CLIENT_SECRET is required[\s\S]*SESSION_SECRET is required/);
  });

  it("a bad value read later names the variable too", () => {
    process.env.PORT = "eighty";
    expect(() => config.PORT).toThrow("PORT must be a whole number from 1 to 65535");
  });

  it("defaults, and values read as their types", () => {
    for (const k of ["EB_CONSENT_DAYS", "SYNC_HOURS", "TZ_NAME", "EB_COUNTRY", "PORT"]) delete process.env[k];
    expect([config.CONSENT_DAYS, config.SYNC_HOURS, config.TIMEZONE, config.COUNTRY, config.PORT]).toEqual([180, 6, "Europe/Athens", "GR", 8000]);
    process.env.SYNC_HOURS = "4.5";
    expect(config.SYNC_HOURS).toBe(4.5);
  });

  it("secrets stay apart from settings", () => {
    expect(Object.keys(config)).not.toContain("SESSION_SECRET");
    expect(secrets.CREDENTIALS_OLD_KEYS).toEqual([]);
    process.env.CREDENTIALS_OLD_KEYS = `${Buffer.alloc(32, "a").toString("base64")}, `;
    expect(secrets.CREDENTIALS_OLD_KEYS).toHaveLength(1);
  });

  it("the clock pin and the scheduler switch come through config", () => {
    process.env.EBBY_NOW = "2026-10-20T09:00:00+03:00";
    process.env.EBBY_SCHEDULER = "off";
    expect([config.NOW, config.SCHEDULER]).toEqual(["2026-10-20T09:00:00+03:00", false]);
    process.env.EBBY_NOW = "yesterday";
    expect(() => validateConfig()).toThrow("EBBY_NOW must be an ISO date");
  });
});

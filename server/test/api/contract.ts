/**
 * The API as a black box: a fresh database holding only the demo person, the clock pinned, requests over HTTP.
 * Local mode (no sign-in, a localhost PUBLIC_URL): requests act as the admin, here the demo person.
 *
 * The snapshots in snapshots/ were first taken from the Python app; every read must still match them number for
 * number. UPDATE_SNAPSHOTS=1 retakes them; review the diff.
 */

import type { Hono } from "hono";
import pg from "pg";

import * as credentials from "../../src/integrations/credentials.js";
import * as db from "../../src/data/db.js";
import * as demo from "../../src/jobs/demo.js";
import * as banks from "../../src/integrations/banks.js";
import { createApp } from "../../src/server.js";
import { _paydays } from "../../src/domain/months.js";

export const NOW = "2026-10-20T09:00:00+03:00";  // a Tuesday morning in Athens, mid pay month

function clearCaches() {
  _paydays.clear(); credentials._clients.clear(); banks._cache.clear();
}

/** Points the app at a fresh database named `name`, seeds the demo person into it and pins the clock. Returns a
 * request function and a teardown that puts everything back. */
export async function contractApp(name: string) {
  const saved = { url: process.env.DATABASE_URL, owner: process.env.DATABASE_OWNER_URL, now: process.env.EBBY_NOW, google: process.env.GOOGLE_CLIENT_ID };
  await db.close();
  const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const swap = (u: string | undefined) => { const x = new URL(u!); x.pathname = `/${name}`; return x.href; };
  process.env.DATABASE_URL = swap(saved.url);
  process.env.DATABASE_OWNER_URL = swap(saved.owner);
  process.env.EBBY_NOW = NOW;
  process.env.GOOGLE_CLIENT_ID = "";
  clearCaches();
  await db.init();
  await demo.seed();
  const app: Hono = createApp();
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost${path}`, { ...init, headers: { Host: "localhost", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers as Record<string, string>) } });
  const json = async (path: string, init: RequestInit = {}) => (await request(path, init)).json();
  const teardown = async () => {
    await db.close();
    Object.assign(process.env, { DATABASE_URL: saved.url, DATABASE_OWNER_URL: saved.owner, GOOGLE_CLIENT_ID: saved.google ?? "" });
    if (saved.now === undefined) delete process.env.EBBY_NOW; else process.env.EBBY_NOW = saved.now;
    clearCaches();
  };
  return { app, request, json, teardown };
}

/** Where two JSON values first differ, or null. Numbers equal to 1e-9 count as equal. */
export function diff(expected: unknown, actual: unknown, at = "$"): string | null {
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    const e = expected as Record<string, unknown>, a = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
      if (!(key in a)) return `${at}.${key}: missing`;
      if (!(key in e)) return `${at}.${key}: unexpected (= ${JSON.stringify(a[key]).slice(0, 80)})`;
      const d = diff(e[key], a[key], `${at}.${key}`);
      if (d) return d;
    }
    return null;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return `${at}: ${actual.length} items, expected ${expected.length}`;
    for (let i = 0; i < expected.length; i++) { const d = diff(expected[i], actual[i], `${at}[${i}]`); if (d) return d; }
    return null;
  }
  if (typeof expected === "number" && typeof actual === "number") {
    return Math.abs(expected - actual) <= 1e-9 * Math.max(1, Math.abs(expected)) ? null : `${at}: ${actual}, expected ${expected}`;
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? null : `${at}: ${JSON.stringify(actual).slice(0, 120)}, expected ${JSON.stringify(expected).slice(0, 120)}`;
}

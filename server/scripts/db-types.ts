/**
 * Regenerates src/types/db.ts, the database's tables as TypeScript, from the migrations: a scratch database is
 * migrated and read by kysely-codegen. Run after adding a migration:  npm run db:types
 * Uses TEST_DATABASE_OWNER_URL's server (default: the local container from .env.example).
 */

import { execFileSync } from "node:child_process";

import pg from "pg";

const NAME = "ebby_db_types";
const server = new URL(process.env.TEST_DATABASE_OWNER_URL ?? "postgresql://bank_sync_owner:owner@localhost:55432/postgres");
const owner = new URL(server.href); owner.pathname = `/${NAME}`;
const app = new URL(owner.href); app.username = "ebby_db_types_app"; app.password = "x";

const admin = new pg.Client({ connectionString: server.href });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${NAME} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${NAME}`);
Object.assign(process.env, { DATABASE_URL: app.href, DATABASE_OWNER_URL: owner.href });
const db = await import("../src/data/db.js");
await db.init();
await db.close();
execFileSync("npx", ["kysely-codegen", "--url", owner.href, "--dialect", "postgres", "--out-file", "src/types/db.ts", "--exclude-pattern", "schema_migrations",
  // How db.ts parses them: bigint ids as numbers, timestamps as ISO strings (the Python app's format).
  "--type-mapping", JSON.stringify({ int8: "number", timestamptz: "string", numeric: "number" })],
  { stdio: "inherit" });
await admin.query(`DROP DATABASE ${NAME} WITH (FORCE)`);
await admin.end();

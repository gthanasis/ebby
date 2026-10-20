/**
 * Postgres, through Kysely. Every query runs in a transaction that tells Postgres whose data it is
 * (app.user_id), so row-level security shows each person only their own rows and no query filters by hand.
 *
 * Queries are SQL as written (with ? placeholders), run through Kysely's raw queries; the typed builder is
 * there for new code.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { CompiledQuery, Kysely, PostgresDialect, type Selectable, type Transaction } from "kysely";
import pg from "pg";

import { config } from "../config.js";
import { categorize, merchantName } from "../domain/categories.js";
import { pyDumps } from "../py.js";
import type { Connections, DB } from "../types/db.js";
import type { Connection, MetaDocuments, MetaKey } from "../types/entities.js";

// ---------- what Postgres hands back, made to match what the Python app returned ----------

pg.types.setTypeParser(20, (v) => parseInt(v, 10));  // bigint ids are numbers
pg.types.setTypeParser(1700, (v) => parseFloat(v));  // numeric
pg.types.setTypeParser(1082, (v) => v);              // date: the ISO string
/** timestamptz as Python's isoformat: 2026-10-20T06:00:00+00:00, microseconds when there are any. */
pg.types.setTypeParser(1184, (v) => {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(?::?(\d{2}))?$/.exec(v);
  if (!m) return v;
  const frac = m[3] ? `.${m[3].padEnd(6, "0")}` : "";
  return `${m[1]}T${m[2]}${frac}${m[4]}:${m[5] ?? "00"}`;
});

export type Row = Record<string, any>;

/** A query's rows. R is what the caller knows the SQL selects; raw SQL itself isn't checked against it. */
export class Result<R = Row> {
  constructor(readonly rows: R[], readonly rowCount: number) {}
  one(): R | undefined { return this.rows[0]; }
  all(): R[] { return this.rows; }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

/** The first column of a row, for SELECT COUNT(*) and the like. */
export const first = (row: Row | undefined) => (row ? Object.values(row)[0] : undefined);

const placeholders = (sql: string) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };

/** One transaction, read like the Python app's connection: execute(sql, params). */
export class Conn {
  constructor(readonly db: Kysely<DB> | Transaction<DB>) {}
  async execute<R = Row>(sql: string, params: unknown[] = []): Promise<Result<R>> {
    const res = await this.db.executeQuery(CompiledQuery.raw(placeholders(sql), params as any[]));
    return new Result(res.rows as R[], Number(res.numAffectedRows ?? res.rows.length));
  }
}

let _db: Kysely<DB> | null = null;
let _pool: pg.Pool | null = null;

export function kysely(): Kysely<DB> {
  if (!_db) {
    if (!config.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    _pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
    // An idle connection the server dropped (a restart, a failover): the pool replaces it on the next query.
    _pool.on("error", (e) => console.warn(`database connection lost: ${e.message}`));
    _db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: _pool }) });
  }
  return _db;
}

export async function close() {
  await _db?.destroy();
  _db = null; _pool = null;
}

// ---------- whose data ----------

export class NoUser extends Error {}

const _user = new AsyncLocalStorage<number | null>();

/** Runs fn acting for a user: every db.connect() inside it, awaited or not, reads and writes as them. */
export const asUser = <T>(userId: number, fn: () => T): T => _user.run(userId, fn);
export const currentUser = (): number | null => _user.getStore() ?? null;

/** One transaction acting for the current user. Without one it refuses outright. */
export async function connect<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  const userId = currentUser();
  if (userId == null) throw new NoUser("db.connect() with no user; wrap the work in db.asUser()");
  return kysely().transaction().execute(async (trx) => {
    // true: for this transaction only, so the pooled connection never carries it into the next one.
    await trx.executeQuery(CompiledQuery.raw("SELECT set_config('app.user_id', $1, true)", [String(userId)]));
    return fn(new Conn(trx));
  });
}

/** A transaction acting for nobody: sees users and sessions, and none of anyone's own rows. */
export async function connectSystem<T>(fn: (conn: Conn) => Promise<T>): Promise<T> {
  return kysely().transaction().execute((trx) => fn(new Conn(trx)));
}

// Advisory lock namespaces: several pods share the database, so "only one at a time" has to live there.
export const LOCK_SCHEDULER = 1;  // the background round, with 0
export const LOCK_SYNC = 2;       // a person's bank sync, with their user id

/**
 * Runs fn with true if this process now holds the lock (space, key), false if another one does. Held on a
 * connection of its own until fn ends; if the process dies, Postgres drops it with the connection.
 */
export async function advisoryLock<T>(space: number, key: number, fn: (mine: boolean) => Promise<T>): Promise<T> {
  return kysely().connection().execute(async (c) => {
    const got = (await c.executeQuery<any>(CompiledQuery.raw("SELECT pg_try_advisory_lock($1, $2) AS got", [space, key]))).rows[0].got;
    try {
      return await fn(got);
    } finally {
      if (got) await c.executeQuery(CompiledQuery.raw("SELECT pg_advisory_unlock($1, $2)", [space, key]));
    }
  });
}

/** Whether any process holds (space, key) right now. */
export async function isLocked(space: number, key: number): Promise<boolean> {
  const res = await kysely().executeQuery<any>(CompiledQuery.raw(
    `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND granted
     AND classid = $1 AND objid = $2 AND objsubid = 2) AS locked`, [space, key]));
  return res.rows[0].locked;
}

// ---------- schema ----------

/** Applies pending migrations as the owner, and makes sure the app's own role exists (it owns nothing). */
export async function init() {
  const app = new URL(config.DATABASE_URL);
  const user = decodeURIComponent(app.username), password = decodeURIComponent(app.password);
  const client = new pg.Client({ connectionString: config.DATABASE_OWNER_URL || config.DATABASE_URL });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(7351)");  // one migrator at a time
    const exists = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [user]);
    if (!exists.rowCount) {
      await client.query(`CREATE ROLE ${client.escapeIdentifier(user)} LOGIN PASSWORD ${client.escapeLiteral(password)}`);
    }
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    for (const name of readdirSync(config.MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
      const version = parseInt(name.split("_")[0], 10);
      if (done.has(version)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(config.MIGRATIONS, name), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    const role = client.escapeIdentifier(user);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
    await client.query("SELECT pg_advisory_unlock(7351)");
  } finally {
    await client.end();
  }
}

// ---------- people ----------

export async function adminId(): Promise<number | null> {
  return connectSystem(async (conn) =>
    (await conn.execute("SELECT id FROM users WHERE is_admin ORDER BY id LIMIT 1")).one()?.id ?? null);
}

export async function activeUsers(): Promise<number[]> {
  return connectSystem(async (conn) =>
    (await conn.execute("SELECT id FROM users WHERE status = 'active' ORDER BY id")).rows.map((r) => r.id));
}

export async function userByEmail(email: string): Promise<Row | null> {
  return connectSystem(async (conn) => (await conn.execute("SELECT * FROM users WHERE email = ?", [email.toLowerCase()])).one() ?? null);
}

// ---------- connections and meta ----------

export async function connections(conn: Conn): Promise<Connection[]> {
  return (await conn.execute<Selectable<Connections>>("SELECT * FROM connections ORDER BY bank")).rows.map((r): Connection => ({
    ...r, last_error: r.last_error ? JSON.parse(r.last_error) : null,
  }));
}

export async function updateConnection(conn: Conn, bank: string, fields: Record<string, unknown>) {
  const values = { ...fields };
  if (values.last_error != null) values.last_error = pyDumps(values.last_error);
  await conn.execute("INSERT INTO connections(bank) VALUES(?) ON CONFLICT(user_id, bank) DO NOTHING", [bank]);
  const keys = Object.keys(values);
  if (!keys.length) return;
  await conn.execute(`UPDATE connections SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE bank = ?`, [...Object.values(values), bank]);
}

/** A document kept in meta, typed by its key (types/entities.ts MetaDocuments); null when there's none. */
export async function getMeta<K extends MetaKey>(conn: Conn, key: K): Promise<MetaDocuments[K] | null>;
/** A document under a key made at runtime (explain:<range>:<start>). */
export async function getMeta(conn: Conn, key: `explain:${string}`): Promise<Row | null>;
export async function getMeta(conn: Conn, key: string): Promise<unknown> {
  const row = (await conn.execute<{ value: string }>("SELECT value FROM meta WHERE key = ?", [key])).one();
  return row ? JSON.parse(row.value) : null;
}

export async function setMeta<K extends MetaKey>(conn: Conn, key: K, value: MetaDocuments[K]): Promise<void>;
export async function setMeta(conn: Conn, key: `explain:${string}`, value: Row): Promise<void>;
export async function setMeta(conn: Conn, key: string, value: unknown) {
  await conn.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value",
    [key, pyDumps(value)]);
}

export async function upsertAccount(conn: Conn, acc: Row, bank: string) {
  const iban: string = acc.account_id?.iban || "";
  // Alpha cards come as OTHR/CARD; Revolut pockets are SVGS and behave like accounts.
  const isCard = !["CACC", "SVGS", "TRAN"].includes(acc.cash_account_type);
  // Alpha names accounts in `product`, Revolut pockets in `details`; Revolut's `name` is just the holder.
  const name: string = acc.product || acc.details || `${bank} ${acc.currency || ""}`.trim();
  await conn.execute(`
    INSERT INTO accounts(id, uid, name, is_card, last4, bank) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET uid = excluded.uid, name = excluded.name, is_card = excluded.is_card,
      last4 = COALESCE(excluded.last4, accounts.last4), bank = excluded.bank
  `, [acc.identification_hash, acc.uid, name.trim(), isCard ? 1 : 0, iban.slice(-4) || null, bank]);
}

// ---------- transactions ----------

/** A bank row's id within its account. Without the bank's own reference, its date, amount and text: must match
 * what the Python app stored, byte for byte, or a sync would store the row a second time. */
export function txKey(tx: Row): string {
  return tx.entry_reference || pyDumps([tx.booking_date ?? null, tx.transaction_amount ?? null, tx.remittance_information ?? null], { sortKeys: true });
}

export async function ownerNames(conn: Conn): Promise<string[]> {
  return (await getMeta(conn, "settings"))?.owner_names || [];
}

export type TxRow = [string, string, string | null, number, string, string, string, string, string | null, string, string];

/** A bank row as stored: [id, account, date, amount, currency, status, description, merchant, mcc, category, raw]. */
export function txRow(account: string, isCard: boolean, tx: Row, rules: Record<string, string>,
                      mccHint: string | null = null, owners: string[] = []): TxRow {
  const amount = tx.transaction_amount || {};
  const outgoing = tx.credit_debit_indicator === "DBIT";
  const value = parseFloat(amount.amount || 0) || 0;
  const description = (tx.remittance_information || []).join(" ");
  const party = (outgoing ? tx.creditor : tx.debtor) || {};
  let merchant = merchantName(party.name || description);
  if (isCard && (merchant === "Αγορά" || merchant === "Επιστροφή")) merchant = "";  // card rows have only a category code
  // Account rows of debit-card purchases carry no code; dedupe() copies the card row's onto them.
  const mcc = tx.merchant_category_code || mccHint;
  const txId = `${account}:${txKey(tx)}`;
  // Rules are keyed by merchant, or by "tx:<id>" for a single row (card rows have no merchant).
  const category = rules[`tx:${txId}`] || (merchant && rules[merchant]) || categorize(description, mcc, outgoing, isCard, owners);
  return [txId, account, tx.booking_date || tx.transaction_date || tx.value_date || null, outgoing ? -value : value,
    amount.currency || "EUR", tx.status || "BOOK", description, merchant, mcc ?? null, category, pyDumps(tx, { ensureAscii: false })];
}

async function rulesOf(conn: Conn): Promise<Record<string, string>> {
  return Object.fromEntries((await conn.execute("SELECT merchant, category FROM rules")).rows.map((r) => [r.merchant, r.category]));
}

/** Stores one fetched date window. Pending rows in it are replaced: they get new ids once booked. */
export async function saveWindow(conn: Conn, account: string, isCard: boolean, start: string, end: string, transactions: Row[]): Promise<number> {
  const rules = await rulesOf(conn);
  const owners = await ownerNames(conn);
  await conn.execute("DELETE FROM transactions WHERE account = ? AND status = 'PDNG' AND date BETWEEN ? AND ?", [account, start, end]);
  let changed = 0;
  for (const tx of transactions) {
    const row = txRow(account, isCard, tx, rules, null, owners);
    if (row[2] == null) continue;
    changed += (await conn.execute(`
      INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, mcc, category, raw)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, id) DO UPDATE SET amount = excluded.amount, status = excluded.status,
        date = CASE WHEN EXISTS (SELECT 1 FROM transactions c WHERE c.duplicate_of = transactions.id
                                 AND c.user_id = transactions.user_id) THEN transactions.date ELSE excluded.date END,
        raw = excluded.raw
    `, row)).rowCount;
  }
  return changed;
}

/** Re-runs the rules over every stored row (after changing rules or categories). */
export async function recategorize(conn: Conn) {
  const rules = await rulesOf(conn);
  const cards = Object.fromEntries((await conn.execute("SELECT id, is_card FROM accounts")).rows.map((r) => [r.id, Boolean(r.is_card)]));
  const owners = await ownerNames(conn);
  for (const r of (await conn.execute("SELECT id, account, raw, mcc FROM transactions")).rows) {
    const row = txRow(r.account, cards[r.account] ?? false, JSON.parse(r.raw), rules, r.mcc, owners);
    await conn.execute("UPDATE transactions SET merchant = ?, category = ? WHERE id = ?", [row[7], row[9], r.id]);
  }
  const { assignCommitments } = await import("../domain/commitments.js");
  await assignCommitments(conn);
}

// A debit card's purchase shows up twice: on the card (category code, no name) and a few days later on its
// current account (merchant name). Credit cards don't: their repayment is one transfer.
export const DEBIT_MATCH_SHARE = 0.6;

/** Pairs debit-card rows with their current-account copies and marks the card row as the duplicate. A card
 * counts as debit when most of its purchases have such a copy. Returns pairs made. */
export async function dedupe(conn: Conn): Promise<number> {
  await conn.execute(`UPDATE transactions SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL
                      AND duplicate_of NOT IN (SELECT id FROM transactions)`);
  let made = 0;
  for (const card of (await conn.execute("SELECT id, bank FROM accounts WHERE is_card = 1")).rows) {
    const rows = (await conn.execute("SELECT id, date, amount, mcc FROM transactions WHERE account = ? AND amount < 0 ORDER BY date",
      [card.id])).rows;
    if (!rows.length) continue;
    const taken = new Set((await conn.execute("SELECT duplicate_of FROM transactions WHERE duplicate_of IS NOT NULL")).rows.map((r) => r.duplicate_of));
    const pairs: [Row, string][] = [];
    for (const r of rows) {
      const matches = (await conn.execute(`
        SELECT t.id FROM transactions t JOIN accounts a ON a.id = t.account
        WHERE a.is_card = 0 AND a.bank = ? AND t.amount = ? AND t.category NOT IN ('transfer', 'investments', 'card_payment', 'income')
          AND t.date::date - ?::date BETWEEN -1 AND 6
        ORDER BY abs(t.date::date - ?::date)
      `, [card.bank, r.amount, r.date, r.date])).rows;
      const m = matches.find((x) => !taken.has(x.id));
      if (m) { taken.add(m.id); pairs.push([r, m.id]); }
    }
    if (pairs.length < rows.length * DEBIT_MATCH_SHARE) continue;  // a credit card, or too few matches to be sure
    for (const [r, accountRow] of pairs) {
      made += (await conn.execute("UPDATE transactions SET duplicate_of = ? WHERE id = ? AND duplicate_of IS NULL", [accountRow, r.id])).rowCount;
      if (r.mcc) await conn.execute("UPDATE transactions SET mcc = ? WHERE id = ? AND (mcc IS NULL OR mcc = '')", [r.mcc, accountRow]);
    }
  }
  // The account books a purchase days after you made it; the card row has the day you paid.
  await conn.execute(`UPDATE transactions t SET date = c.date FROM transactions c
                      WHERE c.duplicate_of = t.id AND c.user_id = t.user_id AND t.date <> c.date`);
  if (made) await recategorize(conn);
  return made;
}

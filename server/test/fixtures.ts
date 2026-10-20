/** A fresh database with two people whose data is easy to spot: anything of A's showing up for B is a leak. */

import pg from "pg";

import * as db from "../src/shared/db.js";
import { ensureUser } from "../src/modules/account/repo.js";

let ready: Promise<{ a: number; b: number }> | null = null;

async function create() {
  const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
  await admin.connect();
  const name = `ebby_ts_test${process.env.EBBY_TEST_DB_SUFFIX ?? ""}`;
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await db.init();
  const a = await ensureUser("a@example.com", true), b = await ensureUser("b@example.com");
  for (const [user, tag] of [[a, "AAA"], [b, "BBB"]] as const) {
    await db.asUser(user, () => db.connect(async (conn) => {
      await conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES(?, ?, ?, 0, 'Alpha Bank')", [`acc-${tag}`, `uid-${tag}`, `Account ${tag}`]);
      const rows: [string, string, number][] = [[`Shop ${tag}`, "groceries", -42.17], [`Wolt ${tag}`, "delivery", -18.5], [`Salary ${tag}`, "income", 1500]];
      for (const [i, [merchant, category, amount]] of rows.entries()) {
        await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, category, raw)
                            VALUES(?, ?, to_char(now() - make_interval(days => ?::int), 'YYYY-MM-DD'), ?, 'EUR', 'BOOK', ?, ?, ?, '{}')`,
          [`acc-${tag}:${i}`, `acc-${tag}`, i + 1, amount, `${merchant} purchase`, merchant, category]);
      }
      await conn.execute("INSERT INTO rules(merchant, category) VALUES(?, 'delivery')", [`Wolt ${tag}`]);
      await conn.execute("INSERT INTO goals(name, price, target_date, created_at) VALUES(?, 900, '2027-06-01', '2026-10-01')", [`Goal ${tag}`]);
      await conn.execute("INSERT INTO commitments(name, monthly_limit, created_at) VALUES(?, 50, '2026-10-01')", [`Commitment ${tag}`]);
      await conn.execute("INSERT INTO connections(bank, session_id) VALUES('Alpha Bank', ?)", [`session-${tag}`]);
      await db.setMeta(conn, "settings", { owner_names: [`Owner ${tag}`] });
    }));
  }
  return { a, b };
}

/** The two people, made once per test run. */
export const users = () => (ready ??= create());

// Getting transactions out of Enable Banking and into ebby, against a fake that behaves like the real banks.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import * as db from "../src/shared/db.js";
import { ensureUser } from "../src/modules/account/repo.js";
import { Client, EnableBankingError, SUSPECT_FULL, WINDOW_DAYS } from "../src/modules/banks/enable_banking.js";
import * as sync from "../src/modules/banks/sync.js";
import { PyDate } from "../src/shared/utils/python.js";
import { users } from "./fixtures.js";
import * as ingest from "../src/modules/banks/ingest.js";
import * as transactionsRepo from "../src/shared/ledger/transactions.js";

type Row = Record<string, any>;
const tx = (day: string, amount: number, text: string, out = true, extra: Row = {}): Row => ({
  entry_reference: `${day}-${text}-${amount}`, booking_date: day, status: "BOOK", credit_debit_indicator: out ? "DBIT" : "CRDT",
  transaction_amount: { amount: String(amount), currency: "EUR" }, remittance_information: [text], ...extra,
});

/** Answers /transactions like Alpha Bank: only the newest `cap` rows of a window, with no way to ask for the rest;
 * pages of `page` rows otherwise. */
class FakeBank extends Client {
  calls: [string, string, string | undefined][] = [];
  constructor(private rows: Row[], private opts: { cap?: number; page?: number; fail?: Error } = {}) { super("app", Buffer.alloc(0)); }
  override async call(_method: string, path: string, o: { params?: Record<string, string> } = {}): Promise<any> {
    if (this.opts.fail) throw this.opts.fail;
    if (path.endsWith("/balances")) {
      return { balances: [{ balance_type: "CLBD", balance_amount: { amount: "10.00" } }, { balance_type: "ITAV", balance_amount: { amount: "12.50" } }] };
    }
    const p = o.params!;
    this.calls.push([p.date_from, p.date_to, p.continuation_key]);
    const rows = this.rows.filter((r) => p.date_from <= r.booking_date && r.booking_date <= p.date_to)
      .sort((a, b) => (a.booking_date < b.booking_date ? 1 : a.booking_date > b.booking_date ? -1 : 0));
    if (this.opts.cap) return { transactions: rows.slice(0, this.opts.cap) };
    const start = parseInt(p.continuation_key ?? "0", 10), page = this.opts.page;
    if (!page) return { transactions: rows };
    return { transactions: rows.slice(start, start + page), continuation_key: start + page < rows.length ? String(start + page) : null };
  }
}

const days = (n: number, start = "2026-10-01") => Array.from({ length: n }, (_, i) => PyDate.fromisoformat(start).addDays(i).isoformat());

beforeAll(users);
afterEach(() => { delete process.env.EBBY_NOW; });

describe("fetching from the bank", () => {
  it("a window the bank truncates is split until nothing is lost", async () => {
    const rows = days(14).flatMap((d) => [0, 1, 2, 3, 4, 5].map((i) => tx(d, 5 + i, `Shop ${i}`)));  // 84 rows
    const bank = new FakeBank(rows, { cap: SUSPECT_FULL });
    const got = await bank.window("uid", new PyDate(2026, 10, 1), new PyDate(2026, 10, 14));
    expect(new Set(got.map((r) => r.entry_reference))).toEqual(new Set(rows.map((r) => r.entry_reference)));
    expect(bank.calls.length).toBeGreaterThan(1);
  });

  it("pages are followed to the end", async () => {
    const bank = new FakeBank(days(10).map((d) => tx(d, 3, "Kiosk")), { page: 4 });
    expect((await bank.window("uid", new PyDate(2026, 10, 1), new PyDate(2026, 10, 10))).length).toBe(10);
    expect(bank.calls.map((c) => c[2])).toEqual([undefined, "4", "8"]);
  });

  it("history is fetched in windows, newest first, without gaps", async () => {
    process.env.EBBY_NOW = "2026-10-20T12:00:00+00:00";
    const windows: [PyDate, PyDate][] = [];
    for await (const [s, e] of new FakeBank([]).transactions("uid", 40)) windows.push([s, e]);
    expect(windows[0][1].isoformat()).toBe("2026-10-20");
    expect(windows.at(-1)![0].isoformat()).toBe("2026-09-10");
    for (let i = 1; i < windows.length; i++) expect(windows[i][1].n).toBe(windows[i - 1][0].n - 1);
    expect(windows.every(([s, e]) => e.diffDays(s) < WINDOW_DAYS)).toBe(true);
  });

  it("a bank row becomes a transaction", () => {
    const row = ingest.txRow("acc", false, tx("2026-10-02", 18.5, "WΟLΤ ΔΕΛΙΒΕΡΥ", true, { creditor: { name: "WΟLΤ" } }), { Wolt: "eating_out" });
    expect(row.slice(2, 8)).toEqual(["2026-10-02", -18.5, "EUR", "BOOK", "WΟLΤ ΔΕΛΙΒΕΡΥ", "Wolt"]);
    expect(row[9]).toBe("eating_out");  // their rule for the payee beats the built-in one
    const pay = ingest.txRow("acc", false, tx("2026-10-25", 2400, "ΜΙΣΘΟΔΟΣΙΑ", false), {});
    expect([pay[3], pay[9]]).toEqual([2400, "income"]);
    const card = ingest.txRow("card", true, tx("2026-10-03", 9.9, "Αγορά", true, { merchant_category_code: "5812" }), {});
    expect([card[7], card[8], card[9]]).toEqual(["", "5812", "eating_out"]);  // no name on card rows, only the code
    expect(ingest.txRow("card", true, tx("2026-10-03", 9.9, "Αγορά", true, { merchant_category_code: "5812" }), { [`tx:${card[0]}`]: "leisure" })[9]).toBe("leisure");
  });

  it("a payment is dated the day you paid, not the day the bank booked it", () => {
    const at = (fields: Record<string, string>) => ingest.paidOn({ status: "BOOK", ...fields });
    expect(at({ booking_date: "2026-09-22", value_date: "2026-09-17" })).toBe("2026-09-17");  // Alpha's account row
    expect(at({ booking_date: "2026-09-19", value_date: "2026-09-21" })).toBe("2026-09-19");  // its card row
    expect(at({ booking_date: "2026-09-22", value_date: "2026-09-17", transaction_date: "2026-09-16" })).toBe("2026-09-16");
    expect(at({ booking_date: "2026-09-22" })).toBe("2026-09-22");
    // Pending rows are replaced by their booking window, so they stay inside it.
    expect(at({ status: "PDNG", booking_date: "2026-09-22", value_date: "2026-09-17" })).toBe("2026-09-22");
  });

  it("a row without the bank's reference gets the same id the Python app gave it", () => {
    const row = { booking_date: "2026-10-01", transaction_amount: { amount: "18.50", currency: "EUR" }, remittance_information: ["WΟLΤ ΔΕΛΙΒΕΡΥ", 'x"y'] };
    expect(ingest.txKey(row)).toBe('["2026-10-01", {"amount": "18.50", "currency": "EUR"}, ["W\\u039fL\\u03a4 \\u0394\\u0395\\u039b\\u0399\\u0392\\u0395\\u03a1\\u03a5", "x\\"y"]]');
  });
});

describe("syncing a bank", () => {
  const BANK = "Test Bank";
  let user: number;
  beforeAll(async () => {
    user = await ensureUser("sync@example.com");
    await db.asUser(user, () => db.connect(async (conn) => {
      await conn.execute(`INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('acc-sync', 'uid-sync', 'Current', 0, '${BANK}')`);
      await db.updateConnection(conn, BANK, { session_id: "session-sync", last_error: null });
    }));
  });
  const connection = () => db.asUser(user, () => db.connect(async (conn) => (await db.connections(conn)).find((c) => c.bank === BANK)!));

  it("stores rows once, with the right balance", async () => {
    process.env.EBBY_NOW = "2026-10-20T12:00:00+00:00";
    const bank = new FakeBank([tx("2026-10-15", 42.17, "ΣΚΛΑΒΕΝΙΤΗΣ"), tx("2026-10-16", 6.2, "Coffee Island")]);
    await db.asUser(user, async () => {
      expect(await sync.syncBank(bank, await connection())).toBe(true);
      expect(await sync.syncBank(bank, await connection())).toBe(true);  // again: nothing doubles
    });
    const [stored, account] = await db.asUser(user, () => db.connect(async (conn) => [
      (await conn.execute("SELECT amount, category FROM transactions WHERE account = 'acc-sync' ORDER BY date")).rows,
      (await conn.execute("SELECT balance FROM accounts WHERE id = 'acc-sync'")).one()!,
    ] as const));
    expect(stored).toEqual([{ amount: -42.17, category: "groceries" }, { amount: -6.2, category: "eating_out" }]);
    expect(account.balance).toBe(12.5);  // interim available beats closing booked
    const c = await connection();
    expect(c.last_sync).toBeTruthy();
    expect(c.last_error).toBeNull();
  });

  it("an expired session asks for reconnecting", async () => {
    const bank = new FakeBank([], { fail: new EnableBankingError(401, "EXPIRED_SESSION", "Session expired") });
    expect(await db.asUser(user, async () => sync.syncBank(bank, await connection()))).toBe(false);
    expect((await connection()).last_error).toMatchObject({ reconnect: true, code: "EXPIRED_SESSION" });
  });

  it("a network hiccup doesn't", async () => {
    const bank = new FakeBank([], { fail: new TypeError("fetch failed") });
    expect(await db.asUser(user, async () => sync.syncBank(bank, await connection()))).toBe(false);
    expect((await connection()).last_error).toMatchObject({ reconnect: false, code: "TypeError" });
  });
});

describe("debit cards", () => {
  it("a paired purchase keeps the day you paid, across syncs", async () => {
    const t = (entry: string, amount: number, booked: string, value: string, text: string, mcc: string | null = null) => ({
      entry_reference: entry, merchant_category_code: mcc, credit_debit_indicator: "DBIT", status: "BOOK",
      transaction_amount: { currency: "EUR", amount: String(amount) }, booking_date: booked, value_date: value, remittance_information: [text],
    });
    const user = await ensureUser("dedupe@example.com");
    const card = [t("c1", 66.91, "2026-10-15", "2026-10-17", "Αγορά", "5411"), t("c2", 23.1, "2026-10-17", "2026-10-18", "Αγορά", "5812")];
    const account = [t("a1", 66.91, "2026-10-19", "2026-10-15", "AB VASILOPOULOS S.A."), t("a2", 23.1, "2026-10-19", "2026-10-17", "WOLT")];
    await db.asUser(user, () => db.connect(async (conn) => {
      await conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('card', 'u1', 'Enter Visa', 1, 'Alpha Bank')");
      await conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('current', 'u2', 'Savings', 0, 'Alpha Bank')");
      for (let i = 0; i < 2; i++) {  // the second sync must not move them back to the booking date
        await ingest.saveWindow(conn, "card", true, "2026-10-01", "2026-10-19", card);
        await ingest.saveWindow(conn, "current", false, "2026-10-01", "2026-10-19", account);
        await ingest.dedupe(conn);
        const counted = (await conn.execute("SELECT date, amount FROM transactions WHERE duplicate_of IS NULL AND amount < 0 ORDER BY date")).rows;
        expect(counted).toEqual([{ date: "2026-10-15", amount: -66.91 }, { date: "2026-10-17", amount: -23.1 }]);
      }
      expect(JSON.parse((await conn.execute("SELECT raw FROM transactions WHERE id LIKE '%a1'")).one()!.raw).booking_date).toBe("2026-10-19");
      // The list shows the day you paid, and the bank's booking day beside it.
      const listed = (await transactionsRepo.list(conn, {}, 10, 0)).rows.map((r) => [r.date, r.booked]);
      expect(listed).toEqual([["2026-10-17", "2026-10-19"], ["2026-10-15", "2026-10-19"]]);
    }));
  });
});

describe("one at a time across pods", () => {
  it("only one scheduler round runs", async () => {
    await db.advisoryLock(db.LOCK_SCHEDULER, 0, async (first) => {
      await db.advisoryLock(db.LOCK_SCHEDULER, 0, async (second) => { expect([first, second]).toEqual([true, false]); });
    });
    await db.advisoryLock(db.LOCK_SCHEDULER, 0, async (after) => expect(after).toBe(true));
  });

  it("a sync running elsewhere is seen and not doubled; another person's isn't in the way", async () => {
    const { a, b } = await users();
    await db.advisoryLock(db.LOCK_SYNC, b, async () => {  // the other pod, mid-sync
      expect(await db.asUser(b, () => sync.isSyncing())).toBe(true);
      expect(await db.asUser(b, () => sync.sync())).toBe(false);
      expect(await db.asUser(a, () => sync.isSyncing())).toBe(false);
    });
    expect(await db.asUser(b, () => sync.isSyncing())).toBe(false);
  });
});

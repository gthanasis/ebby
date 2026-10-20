// The categories people usually have and Greek banks print, and history sorted again when the rules change.
import { beforeAll, describe, expect, it } from "vitest";

import * as db from "../src/data/db.js";
import { ensureUser } from "../src/data/users.js";
import { CATEGORIES, categorize, merchantName, SPENDING } from "../src/core/categories.js";
import { pyDumps } from "../src/utils/python.js";
import { users } from "./fixtures.js";
import * as ingest from "../src/domain/ingest.js";

beforeAll(users);
const out = (description: string, mcc: string | null = null, card = false) => categorize(description, mcc, true, card);

describe("categories", () => {
  it("insurance has its own", () => {
    expect(out("ΑΣΦΑΛΙΣΤΡΑ ΑΥΤΟΚΙΝΗΤΟΥ")).toBe("insurance");
    expect(out("INTERAMERICAN ΑΣΦΑΛΙΣΗ")).toBe("insurance");
    expect(out("", "6300", true)).toBe("insurance");
  });
  it("loan instalments count as spending", () => {
    expect(out("ΔΟΣΗ ΣΤΕΓΑΣΤΙΚΟΥ 123456")).toBe("loans");
    expect(SPENDING.has("loans")).toBe(true);
  });
  it("investing is kept out of spending", () => {
    expect(out("TRADE REPUBLIC BANK")).toBe("investments");
    expect(out("To investment account")).toBe("investments");
    expect(out("", "6211", true)).toBe("investments");
    expect(SPENDING.has("investments")).toBe(false);
  });
  it("education, kids and gifts", () => {
    expect(out("UDEMY ONLINE COURSES")).toBe("education");
    expect(out("ΦΡΟΝΤΙΣΤΗΡΙΟ ΑΓΓΛΙΚΩΝ")).toBe("education");
    expect(out("", "8351", true)).toBe("kids");
    expect(out("UNICEF HELLAS")).toBe("gifts");
    expect(out("", "5992", true)).toBe("gifts");
  });
  it("the old rules still hold", () => {
    expect(out("WΟLΤ")).toBe("delivery");
    expect(out("ΔΕΗ ΛΟΓΑΡΙΑΣΜΟΣ")).toBe("bills");
    expect(out("Anytime Fitness")).toBe("health");
    expect(Object.keys(CATEGORIES)).toEqual(expect.arrayContaining(["insurance", "loans", "investments", "education", "kids", "gifts"]));
  });
  it("transfers to yourself use your own names", () => {
    expect(categorize("To Maria Papadopoulou", null, true, false, ["Maria Papadopoulou"])).toBe("transfer");
    expect(categorize("To Maria Papadopoulou", null, true, false, ["Nikos K"])).toBe("people");
  });
  it("merchant names: Greek look-alikes read as Latin, references dropped", () => {
    expect(merchantName("WΟLΤ ΔΕΛΙΒΕΡΥ")).toBe("WΟLΤ ΔΕΛΙΒΕΡΥ");  // has Greek-only letters: left as it is
    expect(merchantName("WΟLΤ")).toBe("Wolt");
    expect(merchantName("PAYPAL *SPOTIFY 12**34")).toBe("Spotify 12");
  });

  it("re-sorting history follows new rules, and a person's own rule wins", async () => {
    const me = await ensureUser("recategorize@example.com");
    const tx = (text: string) => pyDumps({ remittance_information: [text], credit_debit_indicator: "DBIT", transaction_amount: { amount: "80", currency: "EUR" } });
    const cats = await db.asUser(me, () => db.connect(async (conn) => {
      await conn.execute("INSERT INTO accounts(id, uid, name, is_card, bank) VALUES('acc-R', 'uid-R', 'R', 0, 'Alpha Bank')");
      for (const [i, text] of ["ΑΣΦΑΛΙΣΤΡΑ ΣΠΙΤΙΟΥ", "INTERAMERICAN ΥΓΕΙΑΣ"].entries()) {
        await conn.execute(`INSERT INTO transactions(id, account, date, amount, currency, status, description, merchant, category, raw)
                            VALUES(?, 'acc-R', '2026-10-01', -80, 'EUR', 'BOOK', ?, ?, 'bills', ?)`, [`acc-R:${i}`, text, merchantName(text), tx(text)]);
      }
      await conn.execute("INSERT INTO rules(merchant, category) VALUES(?, 'health')", [merchantName("INTERAMERICAN ΥΓΕΙΑΣ")]);
      await ingest.recategorize(conn);
      return Object.fromEntries((await conn.execute("SELECT id, category FROM transactions")).rows.map((r) => [r.id, r.category]));
    }));
    expect(cats).toEqual({ "acc-R:0": "insurance", "acc-R:1": "health" });
  });
});

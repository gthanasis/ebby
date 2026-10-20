/**
 * A made-up person's money, for screenshots, the demo video and trying the app without a bank.
 *
 * `demo-seed` fills one user with about six months of Greek spending, shaped like what Enable Banking returns, and
 * runs it through the same steps a real sync does (categories, debit-card pairing, the plan). Dates are relative to
 * today, so the demo always looks current. Nothing here is anyone's real data. It only ever touches the demo user's
 * own rows. The same seeded random numbers as the Python app, so it's the same six months.
 */

import * as clock from "../../shared/clock.js";
import * as habits from "../habits/service.js";
import { fmt2, isoUtc, PyDate, pyRound } from "../../shared/utils/python.js";
import { PyRandom } from "../../shared/utils/python_random.js";
import * as db from "../../shared/db.js";
import type { Row } from "../../shared/db.js";
import * as accountsRepo from "../../shared/ledger/accounts.js";
import * as commitmentsRepo from "../commitments/repo.js";
import * as goalsRepo from "../goals/repo.js";
import * as seedRepo from "./repo.js";
import { ensureUser } from "../account/repo.js";
import { localToday, withPayday } from "../../shared/months.js";
import { assignCommitments } from "../commitments/service.js";
import { autofill, getPlan } from "../plan/service.js";
import * as ingest from "../banks/ingest.js";

export const EMAIL = "demo@spending.local";
const DAYS = 185;
const CURRENT = "demo-alpha-current", CARD = "demo-alpha-card", REVOLUT = "demo-revolut";

// [description on the current account, low €, high €, visits a week]
const CURRENT_SPENDS: [string, number, number, number][] = [
  ["SKLAVENITIS", 18, 75, 1.0], ["AB VASILOPOULOS", 10, 45, 0.6], ["LIDL HELLAS", 15, 50, 0.4],
  ["WOLT", 11, 32, 2.2], ["EFOOD", 12, 28, 0.6], ["FOURNOS GEORGIOU", 3, 9, 1.5],
  ["SHELL", 35, 55, 0.35], ["UBER", 6, 18, 0.7], ["OASA ATHENS METRO", 2, 5, 1.2],
  ["PHARMACY MARKOU", 6, 38, 0.25], ["SKROUTZ", 15, 140, 0.3], ["ZARA", 25, 90, 0.12],
  ["IKEA", 20, 180, 0.06], ["VILLAGE CINEMAS", 9, 22, 0.2], ["HAIR STUDIO", 18, 30, 0.12],
];
// Card purchases come with a merchant type only, as Alpha Bank's do: [MCC, low, high, a week]
const CARD_SPENDS: [string, number, number, number][] = [["5813", 3, 12, 3.0], ["5812", 14, 42, 0.7], ["5814", 6, 14, 0.8], ["5411", 8, 40, 0.5]];
const MONTHLY: [number, string, number][] = [  // [day of month, description, amount]
  [1, "ΕΝΟΙΚΙΟ ΔΙΑΜΕΡΙΣΜΑΤΟΣ", 650], [3, "COSMOTE", 42], [6, "ΔΕΗ", 61], [9, "NETFLIX.COM", 13.99],
  [9, "SPOTIFY", 10.99], [12, "ICLOUD APPLE.COM", 2.99], [14, "CLAUDE.AI SUBSCRIPTION", 21.6],
  [15, "GYM FITNESS ATHLETIC", 45], [20, "EYDAP", 19], [22, "VODAFONE MOBILE", 18],
];
const REVOLUT_SPENDS: [string, number, number, number][] = [["Coffee Island", 3, 6, 1.2], ["FreeNow", 5, 14, 0.4], ["Amazon", 12, 70, 0.2]];

class Bank {
  rng = new PyRandom(2026);
  rows: Record<string, Row[]> = { [CURRENT]: [], [CARD]: [], [REVOLUT]: [] };
  n = 0;
  constructor(readonly today: PyDate) {}

  add(account: string, day: PyDate, amount: number, description: string, party: string | null = null, mcc: string | null = null) {
    if (day.n > this.today.n) return;
    this.n += 1;
    const out = amount < 0;
    this.rows[account].push({
      entry_reference: `demo-${this.n}`, booking_date: day.isoformat(), status: "BOOK",
      transaction_amount: { amount: fmt2(Math.abs(amount)), currency: "EUR" },
      credit_debit_indicator: out ? "DBIT" : "CRDT",
      remittance_information: [description],
      [out ? "creditor" : "debtor"]: { name: party || description },
      ...(mcc ? { merchant_category_code: mcc } : {}),
    });
  }

  /** How many times this happens today, for something done `rateAWeek` times a week. */
  spend(rateAWeek: number): number {
    let n = 0;
    for (let i = 0; i < 1 + Math.floor(rateAWeek / 7); i++) if (this.rng.random() < rateAWeek / 7) n += 1;
    return n;
  }

  euros(low: number, high: number): number {
    return pyRound(this.rng.uniform(low, high), 2);
  }
}

export function history(today: PyDate): Record<string, Row[]> {
  const b = new Bank(today);
  const firstDay = today.addDays(-DAYS);
  for (let i = 0; i <= DAYS; i++) {
    const day = firstDay.addDays(i);
    const weekend = day.weekday() >= 5;
    for (const [desc, low, high, base] of CURRENT_SPENDS) {
      const rate = base * (weekend && ["WOLT", "EFOOD", "VILLAGE CINEMAS"].includes(desc) ? 1.5 : 1);
      for (let k = b.spend(rate); k > 0; k--) b.add(CURRENT, day, -b.euros(low, high), `ΑΓΟΡΑ ΜΕ ΚΑΡΤΑ ${desc}`, desc);
    }
    for (const [mcc, low, high, rate] of CARD_SPENDS) {
      for (let k = b.spend(rate * (weekend ? 1.4 : 1)); k > 0; k--) b.add(CARD, day, -b.euros(low, high), "Αγορά", "Αγορά", mcc);
    }
    for (const [name, low, high, rate] of REVOLUT_SPENDS) {
      for (let k = b.spend(rate); k > 0; k--) b.add(REVOLUT, day, -b.euros(low, high), name.toUpperCase(), name);
    }
    for (const [dom, desc, amount] of MONTHLY) if (day.day === dom) b.add(CURRENT, day, -amount, desc);
    if (day.day === 25) b.add(CURRENT, day, 2400, "ΜΙΣΘΟΔΟΣΙΑ ΕΡΓΟΔΟΤΗ", "ΕΡΓΟΔΟΤΗΣ ΑΕ");  // a made-up employer
    if (day.day === 27) {
      b.add(CURRENT, day, -150, "ΜΕΤΑΦΟΡΑ ΣΕ REVOLUT");  // top-up: an own transfer, not spending
      b.add(REVOLUT, day, 150, "Top-Up by card", "Top-Up");
    }
    if (day.day === 5) b.add(CURRENT, day, -pyRound(b.rng.uniform(420, 560), 2), "ΠΛΗΡΩΜΗ ΚΑΡΤΑΣ VISA");  // the card bill
    if ((day.day === 8 || day.day === 21) && b.rng.random() < 0.7) b.add(CURRENT, day, -b.rng.choice([40, 50, 60]), "ΑΝΑΛΗΨΗ ATM");
    if (day.day === 17 && b.rng.random() < 0.5) b.add(REVOLUT, day, -b.rng.choice([15, 20, 25]), "To Nikos Alexiou", "Nikos Alexiou");
  }
  const trip = today.addDays(-58);
  b.add(CURRENT, trip.addDays(-30), -186, "AEGEAN AIRLINES", "AEGEAN AIRLINES");
  b.add(CURRENT, trip, -312, "BOOKING.COM HOTEL", "BOOKING.COM");
  return b.rows;
}

/** Replaces the demo user's data with a fresh made-up history. Returns counts. */
export async function seed(email = EMAIL): Promise<Row> {
  const userId = await ensureUser(email, true);
  // Settings are cleared below, so the seed starts on calendar months.
  return db.asUser(userId, () => withPayday(1, async () => {
    const today = localToday();
    const rows = history(today);
    return db.connect(async (conn) => {
      for (const table of ["transactions", "accounts", "rules", "connections", "goals", "commitments", "habit_rules",
        "wishlist", "assistant_messages", "assistant_actions", "meta"]) {
        await seedRepo.clearOwnRows(conn, table);  // row-level security: only the demo user's own rows
      }
      const now = isoUtc(clock.now(), "seconds");
      for (const [accId, bank, name, isCard, last4, balance] of [
        [CURRENT, "Alpha Bank", "Alpha Μισθοδοσία", 0, "4417", 1842.37], [CARD, "Alpha Bank", "Alpha Bank Bonus Visa", 1, "9021", -386.12],
        [REVOLUT, "Revolut", "Revolut EUR", 0, null, 96.55]] as const) {
        await accountsRepo.addWithBalance(conn, { id: accId, uid: accId, name, is_card: isCard, last4, bank, balance, balance_at: now, synced_at: now });
      }
      await db.setMeta(conn, "settings", { owner_names: ["Maria Papadopoulou"] });
      for (const [accId, txs] of Object.entries(rows)) {
        const dates = txs.map((t) => t.booking_date).sort();
        await ingest.saveWindow(conn, accId, accId === CARD, dates[0], dates[dates.length - 1], txs);
      }
      await ingest.dedupe(conn);
      await assignCommitments(conn);
      await autofill(conn);
      const valid = isoUtc(new Date(clock.now().getTime() + 171 * 86_400_000), "seconds");
      for (const bank of ["Alpha Bank", "Revolut"]) await db.updateConnection(conn, bank, { session_id: `demo-${bank}`, valid_until: valid, last_sync: now });
      await goalsRepo.add(conn, { name: "Lisbon in March", price: 900, saved: 240,
        target_date: new PyDate(today.year + (today.month > 3 ? 1 : 0), 3, 15).isoformat(), created_at: now, kind: "buy" });
      await goalsRepo.add(conn, { name: "Safety net", price: 4500, saved: 1950, target_date: today.addDays(300).isoformat(), created_at: now, kind: "save" });
      await commitmentsRepo.add(conn, { name: "Gym", kind: "chosen", monthly_limit: 45, note: "Three times a week, worth it", services: "[]",
        created_at: now, every_months: 1, amount: 45, next_date: null });
      await habits.addRule(conn, "fewer", "delivery", 2);
      await db.setMeta(conn, "weekly_read", {
        headline: "Weekend delivery is most of the overspend",
        findings: [
          { title: "Weekend Wolt orders", detail: "9 orders across two weekends", amount: 184, unit: "month", category: "delivery" },
          { title: "Coffee most mornings", detail: "21 card coffees this month", amount: 126, unit: "month", category: "coffee_bars" },
          { title: "Skroutz order", detail: "One €138 order on the 11th", amount: 138, unit: "month", category: "shopping" },
        ],
        actions: [
          { text: "Cook on Saturdays, keep Wolt for Sundays", saves_monthly: 70 },
          { text: "Brew coffee at home two days a week", saves_monthly: 32 },
        ],
        body: "Spending is running about 12% ahead of plan, almost all of it delivery on weekends. "
          + "Groceries and bills are on track. Holding delivery to two orders a week would bring the month back in line.",
        created_at: now, model: "demo", budgets: (await getPlan(conn))?.budgets ?? null,
      });
      await db.setMeta(conn, "onboarded", true);
      return { user_id: userId, transactions: Object.fromEntries(Object.entries(rows).map(([a, t]) => [a, t.length])) };
    });
  }));
}

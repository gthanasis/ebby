// Pay months: what every total, budget and pace is counted over. The dates are real 2026 weekdays.
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import * as db from "../src/data/db.js";
import type { Payday } from "../src/types/entities.js";
import { users } from "./fixtures.js";
import { _paydays, monthBounds, monthOf, setPayday, shift } from "../src/domain/months.js";
import { budgetsFor } from "../src/domain/plan.js";
import { orthodoxEaster } from "../src/domain/extra_pay.js";

let a: number;
beforeAll(async () => { a = (await users()).a; });
afterEach(() => _paydays.clear());
const paidOn = (day: Payday, fn: () => void) => db.asUser(a, () => { setPayday(day); fn(); });

describe("pay months", () => {
  it("payday 1 is the calendar month", () => paidOn(1, () => {
    expect(monthBounds("2026-10")).toEqual(["2026-10-01", "2026-11-01"]);
    expect(monthBounds("2026-12")).toEqual(["2026-12-01", "2027-01-01"]);
  }));
  it("a late payday starts the next month and moves off weekends", () => paidOn(25, () => {
    expect(monthBounds("2026-10")).toEqual(["2026-09-25", "2026-10-23"]);  // 25 Oct is a Sunday
    expect(monthBounds("2026-11")).toEqual(["2026-10-23", "2026-11-25"]);
  }));
  it("an early payday starts its own month", () => paidOn(10, () => expect(monthBounds("2026-10")).toEqual(["2026-10-09", "2026-11-10"])));
  it("the last working day", () => paidOn("last", () => expect(monthBounds("2026-10")).toEqual(["2026-09-30", "2026-10-30"])));
  it("a payday past the month's end is its last day", () => paidOn(31, () => expect(monthBounds("2026-03")).toEqual(["2026-02-27", "2026-03-31"])));
  it("which pay month a day is in", () => {
    paidOn(25, () => {
      expect(monthOf("2026-10-22")).toBe("2026-10");
      expect(monthOf("2026-10-23")).toBe("2026-11");  // payday itself opens the next month
      expect(monthOf("2026-09-24")).toBe("2026-09");
    });
    paidOn(1, () => expect(monthOf("2026-10-31")).toBe("2026-10"));
  });
  it("months shift across years", () => {
    expect(shift("2026-01", -1)).toBe("2025-12");
    expect(shift("2026-12", 1)).toBe("2027-01");
    expect(shift("2026-10", -18)).toBe("2025-04");
  });
  it("pay months need the payday read first, rather than guessing the 1st", () =>
    db.asUser(a, () => expect(() => monthBounds("2026-10")).toThrow(/payday not loaded/)));
  it("a month's limit scales the budgets and adds up to it", () => {
    const plan = { budgets: { groceries: 400, eating_out: 200, delivery: 100 }, limits: { "2026-10": 1000 / 3 } };
    const scaled = budgetsFor(plan, "2026-10");
    expect(Math.round(Object.values(scaled).reduce((s, v) => s + v, 0) * 100) / 100).toBe(Math.round(1000 / 3 * 100) / 100);
    expect(scaled.groceries).toBeGreaterThan(scaled.eating_out);
    expect(budgetsFor(plan, "2026-11")).toEqual(plan.budgets);
    expect(budgetsFor(null, "2026-10")).toEqual({});
  });
  it("Greek Easter", () => {
    expect(orthodoxEaster(2026).isoformat()).toBe("2026-04-12");
    expect(orthodoxEaster(2027).isoformat()).toBe("2027-05-02");
  });
});

// Pay months: what every total, budget and pace is counted over. The dates are real 2026 weekdays.
import { beforeAll, describe, expect, it } from "vitest";

import * as db from "../src/shared/db.js";
import type { Payday } from "../src/types/entities.js";
import { users } from "./fixtures.js";
import { monthBounds, monthOf, PayCalendar, payStarts, setPayday, shift, withPayday } from "../src/shared/months.js";
import { PyDate } from "../src/shared/utils/python.js";
import { budgetsFor } from "../src/modules/plan/service.js";
import { orthodoxEaster } from "../src/modules/plan/extra_pay.js";

let a: number;
beforeAll(async () => { a = (await users()).a; });
const paidOn = (day: Payday, fn: () => void) => db.asUser(a, () => withPayday(day, fn));

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
  it("a pay calendar needs no person or database", () => {
    const cal = new PayCalendar(25);
    expect(cal.monthBounds("2026-10")).toEqual(["2026-09-25", "2026-10-23"]);
    expect(cal.monthOf("2026-10-23")).toBe("2026-11");
  });
  it("a payday saved mid-request applies to the rest of it, and only to it", () => paidOn(1, () => {
    withPayday(1, () => {
      setPayday(25);
      expect(monthBounds("2026-10")[0]).toBe("2026-09-25");
    });
    expect(monthBounds("2026-10")[0]).toBe("2026-10-01");
  }));
  it("pay months need the payday read first, rather than guessing the 1st", () =>
    db.asUser(a, () => expect(() => monthBounds("2026-10")).toThrow(/no pay calendar/)));
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

describe("months that start when pay arrives", () => {
  // Paid about €2,400 on the 25th; 25 Oct 2026 is a Sunday, so October's pay is due Friday the 23rd.
  const pay = (date: string, amount = 2400) => ({ date, amount, payer: "ACME LTD" });
  const history = [pay("2026-07-24"), pay("2026-08-25"), pay("2026-09-25")];
  const on = (today: string, deposits = history, wait = 5) => payStarts(25, deposits, PyDate.fromisoformat(today), wait);

  it("pay on time starts the month as the payday would", () => {
    const cal = on("2026-10-24", [...history, pay("2026-10-23")]);
    expect(cal.monthBounds("2026-11")[0]).toBe("2026-10-23");
    expect(cal.waiting).toBeNull();
    expect(cal.arrived).toEqual({ date: "2026-10-23", amount: 2400, payer: "ACME LTD" });
  });
  it("late pay keeps the month before open, and says until when", () => {
    const cal = on("2026-10-26");
    expect(cal.monthOf("2026-10-26")).toBe("2026-10");
    expect(cal.monthBounds("2026-10")).toEqual(["2026-09-25", "2026-10-27"]);
    expect(cal.waiting).toEqual({ expected: "2026-10-23", until: "2026-10-28", amount: 2400, payer: "ACME LTD" });
  });
  it("when it lands, the new month starts that day", () => {
    const cal = on("2026-10-27", [...history, pay("2026-10-27")]);
    expect(cal.monthBounds("2026-10")[1]).toBe("2026-10-27");
    expect(cal.monthOf("2026-10-27")).toBe("2026-11");
    expect(cal.waiting).toBeNull();
  });
  it("pay a few days early starts the month early", () => {
    expect(on("2026-10-21", [...history, pay("2026-10-20")]).monthOf("2026-10-21")).toBe("2026-11");
  });
  it("past the wait, the month starts anyway", () => {
    const cal = on("2026-10-29");
    expect(cal.waiting).toBeNull();
    expect(cal.monthOf("2026-10-29")).toBe("2026-11");
  });
  it("a bonus isn't pay, and no deposits leaves the payday alone", () => {
    expect(on("2026-10-26", [...history, pay("2026-10-24", 300)]).waiting).not.toBeNull();
    expect(payStarts(25, [], PyDate.fromisoformat("2026-10-26"), 5).monthBounds("2026-10")).toEqual(new PayCalendar(25).monthBounds("2026-10"));
  });
});

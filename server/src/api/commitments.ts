/** Commitments: fixed and chosen costs, kept apart from free spending. */

import type { Hono } from "hono";
import { z } from "zod";

import * as clock from "../clock.js";
import * as db from "../data/db.js";
import type { Conn } from "../data/db.js";
import { isoUtc, PyDate, pyDumps, pyRound } from "../py.js";
import * as commitmentsRepo from "../data/repos/commitments.js";
import { body, bool, fail, int, integer, num } from "./http.js";
import { assignCommitments, commitmentsView, servicesSeen } from "../domain/commitments.js";
import { resplit } from "../domain/plan.js";
import { thisMonth } from "../domain/months.js";

const CommitmentIn = z.object({
  name: z.string(), kind: z.string().default("chosen"), monthly_limit: num, note: z.string().default(""),
  services: z.array(z.string()).default([]), off_bank: num.default(0),
  every_months: integer.default(1),          // 1, 3, 6 or 12
  amount: num.nullable().default(null),       // each time, for costs paid every few months
  next_date: z.string().nullable().default(null),
});
type Commitment = z.infer<typeof CommitmentIn>;

function check(b: Commitment) {
  if (![1, 3, 6, 12].includes(b.every_months)) fail(400, "How often is every 1, 3, 6 or 12 months");
  if (b.every_months > 1) {
    // The budget sets aside a monthly share of a cost paid every few months.
    if (!b.amount || b.amount <= 0) fail(400, "A cost paid every few months needs the amount you pay each time");
    try { PyDate.fromisoformat(b.next_date || ""); } catch { fail(400, "A cost paid every few months needs the date of its next payment"); }
    b.monthly_limit = pyRound(b.amount! / b.every_months, 2);
  } else {
    b.amount = b.next_date = null;
  }
  if (!b.name.trim() || b.monthly_limit <= 0 || !["fixed", "chosen"].includes(b.kind)) {
    fail(400, "A commitment needs a name, a limit above zero, and kind fixed or chosen");
  }
  if (!b.services.length && b.off_bank <= 0 && b.every_months === 1) fail(400, "Pick the payments it covers, or the amount you pay outside your accounts");
}

/** The row's columns: services stored as JSON text, as the Python app wrote them. */
const columns = (b: Commitment) => ({
  name: b.name.trim(), kind: b.kind, monthly_limit: b.monthly_limit, note: b.note.trim(), services: pyDumps(b.services),
  off_bank: Math.max(0, b.off_bank), every_months: b.every_months, amount: b.amount, next_date: b.next_date,
});

async function after(conn: Conn) {
  await assignCommitments(conn);
  await resplit(conn);
  return commitmentsView(conn, thisMonth());
}

export function routes(app: Hono) {
  app.get("/api/commitments", async (c) => c.json(await db.connect((conn) => commitmentsView(conn, c.req.query("month") || thisMonth()))));

  /** Services to pick from when creating a commitment; with transfers, big transfers over 13 months too. */
  app.get("/api/commitments/services", async (c) => {
    const transfers = bool(c.req.query("transfers"), "transfers", false);
    return c.json(await db.connect((conn) => (transfers ? servicesSeen(conn, 13, true) : servicesSeen(conn))));
  });

  app.post("/api/commitments", async (c) => {
    const b = await body(c, CommitmentIn);
    check(b);
    return c.json(await db.connect(async (conn) => {
      await commitmentsRepo.add(conn, { ...columns(b), created_at: isoUtc(clock.now()) });
      return after(conn);
    }));
  });

  app.put("/api/commitments/:cid", async (c) => {
    const cid = int(c.req.param("cid"), "cid", 0);
    const b = await body(c, CommitmentIn);
    check(b);
    return c.json(await db.connect(async (conn) => {
      if (!(await commitmentsRepo.exists(conn, cid))) fail(404, "No such commitment");
      await commitmentsRepo.update(conn, cid, columns(b));
      return after(conn);
    }));
  });

  app.delete("/api/commitments/:cid", async (c) => {
    const cid = int(c.req.param("cid"), "cid", 0);
    return c.json(await db.connect(async (conn) => {
      await commitmentsRepo.remove(conn, cid);
      return after(conn);
    }));
  });
}

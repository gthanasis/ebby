/** One payment as its sheet shows it, and linking it to a fixed cost by hand. */

import type { Conn } from "../../shared/db.js";
import { fail } from "../../shared/http.js";
import * as payeeNamesRepo from "../../shared/ledger/payee_names.js";
import * as tx from "../../shared/ledger/transactions.js";
import { sorted } from "../../shared/utils/python.js";
import * as commitmentsRepo from "../commitments/repo.js";
import { assignCommitments } from "../commitments/service.js";
import { bankPayee } from "../banks/ingest.js";
import { serviceName } from "../spending/services.js";
import { type Payment, toPayment } from "./converters.js";

export async function payment(conn: Conn, id: string): Promise<Payment> {
  const row = await tx.detail(conn, id);
  if (!row) fail(404, "No such payment");
  const r = row!;
  const costs = sorted((await commitmentsRepo.all(conn)).map((c) => ({ id: c.id, name: c.name })), (c) => [c.name, c.id]);
  // Whether you've named its payee, so the sheet keeps offering to change (or drop) that name.
  const raw = await tx.rawOf(conn, id);
  const payee = raw ? bankPayee(Boolean(raw.is_card), JSON.parse(raw.raw)) : "";
  const named = Boolean(payee && (await payeeNamesRepo.all(conn))[payee]);
  return toPayment(r, serviceName(r.merchant, r.description, Boolean(r.is_card), r.mcc), costs, named);
}

/** Links a payment to a fixed cost whatever its payee (a transfer to a landlord, a nameless card charge), or with
 * null lets its payee decide again. Spending and the fixed costs' months follow at once. */
export async function pin(conn: Conn, id: string, commitmentId: number | null): Promise<Payment> {
  if (commitmentId != null && !(await commitmentsRepo.exists(conn, commitmentId))) fail(404, "No such fixed cost");
  if (!(await tx.pinCommitment(conn, id, commitmentId))) fail(404, "No such payment");
  await assignCommitments(conn);
  return payment(conn, id);
}

/** Turning what a bank sends into stored rows: accounts, transactions with their payee and category, and debit-card
 * purchases paired with their current-account copies. */

import { type Conn, type Row } from "../../shared/db.js";
import * as accountsRepo from "../../shared/ledger/accounts.js";
import * as rulesRepo from "../../shared/ledger/rules.js";
import * as transactionsRepo from "../../shared/ledger/transactions.js";
import { pyDumps } from "../../shared/utils/python.js";
import { readSettings } from "../../shared/settings.js";
import { categorize, merchantName } from "../../shared/categories.js";
import { assignCommitments } from "../commitments/service.js";
import { serviceIdsAnywhere } from "../spending/services.js";

export async function upsertAccount(conn: Conn, acc: Row, bank: string) {
  const iban: string = acc.account_id?.iban || "";
  // Alpha cards come as OTHR/CARD; Revolut pockets are SVGS and behave like accounts.
  const isCard = !["CACC", "SVGS", "TRAN"].includes(acc.cash_account_type);
  // Alpha names accounts in `product`, Revolut pockets in `details`; Revolut's `name` is just the holder.
  const name: string = acc.product || acc.details || `${bank} ${acc.currency || ""}`.trim();
  await accountsRepo.upsert(conn, { id: acc.identification_hash, uid: acc.uid, name: name.trim(), is_card: isCard ? 1 : 0, last4: iban.slice(-4) || null, bank });
}

/** A bank row's id within its account. Without the bank's own reference, its date, amount and text: must match
 * what the Python app stored, byte for byte, or a sync would store the row a second time. */
export function txKey(tx: Row): string {
  return tx.entry_reference || pyDumps([tx.booking_date ?? null, tx.transaction_amount ?? null, tx.remittance_information ?? null], { sortKeys: true });
}

export async function ownerNames(conn: Conn): Promise<string[]> {
  return (await readSettings(conn)).owner_names;
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
  return [txId, account, paidOn(tx), outgoing ? -value : value,
    amount.currency || "EUR", tx.status || "BOOK", description, merchant, mcc ?? null, category, pyDumps(tx, { ensureAscii: false })];
}

/** The day you paid. Alpha books an account payment days later and keeps the day you paid as its value date; a card
 * row it books on the day and values later. So: the bank's transaction date, else the earlier of the two. Pending rows
 * keep their booking date, which saveWindow() replaces them by. */
export function paidOn(tx: Row): string | null {
  if (tx.transaction_date) return tx.transaction_date;
  const booked: string | undefined = tx.booking_date, valued: string | undefined = tx.value_date;
  if (tx.status === "PDNG" || !booked || !valued) return booked || valued || null;
  return valued < booked ? valued : booked;
}

/** Stores one fetched date window. Pending rows in it are replaced: they get new ids once booked. */
export async function saveWindow(conn: Conn, account: string, isCard: boolean, start: string, end: string, transactions: Row[]): Promise<number> {
  const rules = await rulesRepo.all(conn);
  const owners = await ownerNames(conn);
  await transactionsRepo.deletePending(conn, account, start, end);
  let changed = 0;
  for (const tx of transactions) {
    const row = txRow(account, isCard, tx, rules, null, owners);
    if (row[2] == null) continue;
    changed += await transactionsRepo.upsertBankRow(conn, row);
  }
  return changed;
}

/** Re-runs the rules over every stored row (after changing rules or categories). */
export async function recategorize(conn: Conn) {
  const rules = await rulesRepo.all(conn);
  const cards = await accountsRepo.cardFlags(conn);
  const owners = await ownerNames(conn);
  for (const r of await transactionsRepo.allRaw(conn)) {
    const row = txRow(r.account, cards[r.account] ?? false, JSON.parse(r.raw), rules, r.mcc, owners);
    await transactionsRepo.setMerchantAndCategory(conn, r.id, row[7], row[9]);
  }
  await assignCommitments(conn);
}

// A debit card's purchase shows up twice: on the card (category code, no name) and a few days later on its
// current account (merchant name). Credit cards don't: their repayment is one transfer.
export const DEBIT_MATCH_SHARE = 0.6;

/** Pairs debit-card rows with their current-account copies and marks the card row as the duplicate. A card
 * counts as debit when most of its purchases have such a copy. Returns pairs made. */
export async function dedupe(conn: Conn): Promise<number> {
  await transactionsRepo.clearOrphanDuplicates(conn);
  let made = 0;
  for (const card of await accountsRepo.cards(conn)) {
    const rows = await transactionsRepo.cardPurchases(conn, card.id);
    if (!rows.length) continue;
    const taken = await transactionsRepo.paired(conn);
    const pairs: [(typeof rows)[number], string][] = [];
    for (const r of rows) {
      const matches = await transactionsRepo.accountCopies(conn, card.bank, r.amount, r.date);
      const m = matches.find((x) => !taken.has(x.id));
      if (m) { taken.add(m.id); pairs.push([r, m.id]); }
    }
    if (pairs.length < rows.length * DEBIT_MATCH_SHARE) continue;  // a credit card, or too few matches to be sure
    for (const [r, accountRow] of pairs) {
      made += await transactionsRepo.markDuplicate(conn, r.id, accountRow);
      if (r.mcc) await transactionsRepo.fillMcc(conn, accountRow, r.mcc);
    }
  }
  // The account books a purchase days after you made it; the card row has the day you paid.
  await transactionsRepo.datePairsByCard(conn);
  if (made) await recategorize(conn);
  return made;
}

/** All payments to a service go to category, now and in future (rules keyed by merchant). */
export async function setServiceCategory(conn: Conn, name: string, category: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) {
    await rulesRepo.set(conn, r.merchant || `tx:${r.id}`, category);
  }
  await recategorize(conn);
  return rows.length;
}

/** Undo setServiceCategory: drop the service's rules so its payments go back to being worked out. */
export async function clearServiceCategory(conn: Conn, name: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) await rulesRepo.remove(conn, r.merchant || `tx:${r.id}`);
  await recategorize(conn);
  return rows.length;
}

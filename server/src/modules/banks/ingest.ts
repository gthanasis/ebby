/** Turning what a bank sends into stored rows: accounts, transactions with their payee and category, and debit-card
 * purchases paired with their current-account copies. */

import { type Conn, type Row } from "../../shared/db.js";
import * as accountsRepo from "../../shared/ledger/accounts.js";
import * as payeeNamesRepo from "../../shared/ledger/payee_names.js";
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

/** The payee as the bank's text gives it, before any name of yours: what payee_names is keyed by. */
export function bankPayee(isCard: boolean, tx: Row): string {
  const description = (tx.remittance_information || []).join(" ");
  const party = (tx.credit_debit_indicator === "DBIT" ? tx.creditor : tx.debtor) || {};
  const merchant = merchantName(party.name || description);
  return isCard && (merchant === "Αγορά" || merchant === "Επιστροφή") ? "" : merchant;  // card rows have only a category code
}

/** A bank row as stored: [id, account, date, amount, currency, status, description, merchant, mcc, category, raw].
 * names: your own names for payees, which stand in for the bank's as the merchant. */
export function txRow(account: string, isCard: boolean, tx: Row, rules: Record<string, string>,
                      mccHint: string | null = null, owners: string[] = [], names: Record<string, string> = {}): TxRow {
  const amount = tx.transaction_amount || {};
  const outgoing = tx.credit_debit_indicator === "DBIT";
  const value = parseFloat(amount.amount || 0) || 0;
  const description = (tx.remittance_information || []).join(" ");
  const payee = bankPayee(isCard, tx);
  const merchant = (payee && names[payee]) || payee;
  // Account rows of debit-card purchases carry no code; dedupe() copies the card row's onto them.
  const mcc = tx.merchant_category_code || mccHint;
  const txId = `${account}:${txKey(tx)}`;
  // Rules are keyed by merchant, or by "tx:<id>" for a single row (card rows have no merchant). A rule made before the
  // payee was named is keyed by the bank's payee, so it still holds.
  const category = rules[`tx:${txId}`] || (merchant && rules[merchant]) || (payee && rules[payee])
    || categorize(description, mcc, outgoing, isCard, owners);
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
  const names = await payeeNamesRepo.all(conn);
  await transactionsRepo.deletePending(conn, account, start, end);
  let changed = 0;
  for (const tx of transactions) {
    const row = txRow(account, isCard, tx, rules, null, owners, names);
    if (row[2] == null) continue;
    changed += await transactionsRepo.upsertBankRow(conn, row);
  }
  return changed;
}

// Bump when the rule for a payment's day changes: each person's stored payments are dated again from what the bank
// sent, which is kept with every row (raw), so no sync is needed and history outside the sync window is fixed too.
export const DATES_VERSION = 1;

/** Dates every stored payment again from what the bank sent: the day you paid (paidOn). An account row paired with a
 * debit card's row then takes the card's day, as dedupe() leaves it. Returns rows that moved. */
export async function redate(conn: Conn): Promise<number> {
  let moved = 0;
  for (const r of await transactionsRepo.datesAndRaw(conn)) {
    const day = paidOn(JSON.parse(r.raw));  // rows logged by hand (cash) carry no bank dates: kept as they are
    if (day && day !== r.date) moved += await transactionsRepo.setDate(conn, r.id, day);
  }
  await transactionsRepo.datePairsByCard(conn);
  return moved;
}

/** Re-runs the rules over every stored row (after changing rules or categories). */
export async function recategorize(conn: Conn) {
  const rules = await rulesRepo.all(conn);
  const cards = await accountsRepo.cardFlags(conn);
  const owners = await ownerNames(conn);
  const names = await payeeNamesRepo.all(conn);
  for (const r of await transactionsRepo.allRaw(conn)) {
    const row = txRow(r.account, cards[r.account] ?? false, JSON.parse(r.raw), rules, r.mcc, owners, names);
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

/** Gives the payee of payment txId your own name, for every payment to it now and in future; an empty name gives it
 * back the bank's. Returns the payee as the bank knows it, the name it shows under, and how many payments that is;
 * undefined when there's no such payment, null payee when the bank gave it none to name (a card's category code). */
export async function namePayee(conn: Conn, txId: string, name: string): Promise<{ payee: string | null; merchant: string; payments: number } | undefined> {
  const row = await transactionsRepo.rawOf(conn, txId);
  if (!row) return undefined;
  const payee = bankPayee(Boolean(row.is_card), JSON.parse(row.raw));
  if (!payee) return { payee: null, merchant: "", payments: 0 };
  if (name && name !== payee) await payeeNamesRepo.set(conn, payee, name);
  else await payeeNamesRepo.remove(conn, payee);
  await recategorize(conn);
  const merchant = name || payee;
  return { payee, merchant, payments: await transactionsRepo.countByMerchant(conn, merchant) };
}

/** Undo setServiceCategory: drop the service's rules so its payments go back to being worked out. */
export async function clearServiceCategory(conn: Conn, name: string): Promise<number> {
  const rows = await serviceIdsAnywhere(conn, name);
  for (const r of rows) await rulesRepo.remove(conn, r.merchant || `tx:${r.id}`);
  await recategorize(conn);
  return rows.length;
}

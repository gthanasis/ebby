/** Which accounts are savings: the ones you chose, or else the ones named like savings. */

import * as db from "../../shared/db.js";
import type { Conn } from "../../shared/db.js";
import * as accountsRepo from "../../shared/ledger/accounts.js";
import { CASH_ACCOUNT } from "../../shared/constants.js";

const SAVINGS_HINTS = ["αποταμίευση", "saving", "spare", "fund", "pocket"];

/** Your own accounts, without the hand-kept Cash one. */
export const accounts = (conn: Conn) => accountsRepo.own(conn, CASH_ACCOUNT);

export async function savingsAccountIds(conn: Conn): Promise<string[]> {
  const chosen = await db.getMeta(conn, "savings_accounts");
  if (chosen != null) return chosen;
  // Default: accounts named like savings, and Revolut pockets (named by you, not "Revolut EUR").
  return (await accounts(conn)).filter((a) => {
    const n = a.name.toLowerCase();
    return SAVINGS_HINTS.some((h) => n.includes(h)) || (a.bank === "Revolut" && !a.name.startsWith("Revolut"));
  }).map((a) => a.id);
}


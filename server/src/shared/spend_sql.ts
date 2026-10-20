/** The SQL that picks out free spending and committed costs, shared until repositories replace it. */

import { sorted } from "./utils/python.js";
import { SPENDING } from "./categories.js";

// Debit-card copies (duplicate_of set) are left out: their current-account row is the one that counts.
// Free spending: what the plan's budgets, alerts and cuts are about. Committed rows are kept apart.
export const SPEND_ARGS = sorted(SPENDING);
export const SPEND_SQL = `duplicate_of IS NULL AND commitment_id IS NULL AND currency = 'EUR' AND category IN (${SPEND_ARGS.map(() => "?").join(",")})`;
export const COMMITTED_SQL = "duplicate_of IS NULL AND commitment_id IS NOT NULL AND currency = 'EUR'";

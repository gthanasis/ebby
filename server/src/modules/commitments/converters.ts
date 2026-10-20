/** Commitments as the API shows them, from their rows: pure, no database. */

import type { z } from "zod";

import { pyRound } from "../../shared/utils/python.js";
import type { Commitment as CommitmentRow } from "../../types/entities.js";
import type * as S from "./schemas.js";

export type Commitment = z.infer<typeof S.Commitment>;
export type CommitmentSuggestion = z.infer<typeof S.CommitmentSuggestion>;

/** A commitment with what went to it this month, and the six months up to it. */
export function toCommitment(c: CommitmentRow, spent: number, count: number, over: boolean, history: Commitment["history"]): Commitment {
  return { ...c, kind: c.kind as Commitment["kind"], spent: pyRound(spent, 2), count, over, history };
}

/** A payment to cover, with a limit a tenth above it, rounded up to the ten. */
export function toCommitmentSuggestion(service: string, monthly: number): CommitmentSuggestion {
  return { service, monthly, limit: Math.max(10, -Math.floor(-monthly * 1.1 / 10) * 10) };
}

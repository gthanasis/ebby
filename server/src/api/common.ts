/** What several route modules read the same way. */

import { config } from "../config.js";
import * as db from "../data/db.js";
import type { Conn, Row } from "../data/db.js";
import { ASSISTANT_MODELS } from "../domain/constants.js";
import * as goalsRepo from "../data/repos/goals.js";
import { goalView } from "../domain/goals.js";

export async function settings(conn: Conn): Promise<Row> {
  const model = Object.entries(ASSISTANT_MODELS).find(([, v]) => v === config.ASSISTANT_MODEL)?.[0] ?? "haiku";
  return { alerts: true, weekly_read: true, assistant_model: model, ...((await db.getMeta(conn, "settings")) || {}) };
}

export async function goals(conn: Conn): Promise<Row[]> {
  const out = [];
  for (const r of await goalsRepo.all(conn)) out.push(await goalView(conn, r));
  return out;
}

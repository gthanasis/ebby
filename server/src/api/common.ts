/** What several route modules read the same way. */

import { config } from "../config.js";
import * as db from "../data/db.js";
import type { Conn, Row } from "../data/db.js";
import { ASSISTANT_MODELS } from "../domain/constants.js";
import * as insights from "../domain/insights.js";
import type { Goal } from "../types/entities.js";

export async function settings(conn: Conn): Promise<Row> {
  const model = Object.entries(ASSISTANT_MODELS).find(([, v]) => v === config.ASSISTANT_MODEL)?.[0] ?? "haiku";
  return { alerts: true, weekly_read: true, assistant_model: model, ...((await db.getMeta(conn, "settings")) || {}) };
}

export async function goals(conn: Conn): Promise<Row[]> {
  const out = [];
  for (const r of await conn.execute<Goal>("SELECT * FROM goals ORDER BY target_date")) out.push(await insights.goalView(conn, r));
  return out;
}

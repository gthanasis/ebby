/** A person's settings, with the defaults filled in. */

import { config } from "../../config.js";
import type { Conn, Row } from "../../shared/db.js";
import { ASSISTANT_MODELS } from "../../shared/constants.js";
import { storedSettings } from "../../shared/settings.js";

export async function settings(conn: Conn): Promise<Row> {
  const model = Object.entries(ASSISTANT_MODELS).find(([, v]) => v === config.ASSISTANT_MODEL)?.[0] ?? "haiku";
  return { alerts: true, weekly_read: true, assistant_model: model, ...(await storedSettings(conn)) };
}

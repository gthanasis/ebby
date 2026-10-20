/** A person's settings document, and the defaults every feature reads it with. */

import * as db from "./db.js";
import type { Conn } from "./db.js";
import type { Payday, Settings } from "../types/entities.js";

/** Hours of work a month, for "that's about N hours of work". */
export const DEFAULT_WORK_HOURS = 160;

export interface ResolvedSettings extends Settings {
  alerts: boolean;
  weekly_read: boolean;
  work_hours: number;
  payday: Payday;
  owner_names: string[];
}

/** The document as stored, nothing filled in: what Settings shows is built from this. */
export async function storedSettings(conn: Conn): Promise<Settings> {
  return (await db.getMeta(conn, "settings")) || {};
}

/** The stored settings with the defaults applied. */
export async function readSettings(conn: Conn): Promise<ResolvedSettings> {
  const s = await storedSettings(conn);
  return {
    ...s,
    alerts: s.alerts ?? true,
    weekly_read: s.weekly_read ?? true,
    work_hours: s.work_hours ?? DEFAULT_WORK_HOURS,
    payday: s.payday || 1,
    owner_names: s.owner_names || [],
  };
}

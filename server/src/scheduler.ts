/** The background round: for each active person, bank sync, alerts and the weekly read. It brings several modules
 * together, so it lives beside server.ts rather than in any one of them. */

import * as clock from "./shared/clock.js";
import { config } from "./config.js";
import * as ai from "./modules/assistant/ai.js";
import * as aiUsage from "./modules/assistant/ai_usage.js";
import * as alerts from "./modules/alerts/service.js";
import * as push from "./modules/alerts/push.js";
import * as ingest from "./modules/banks/ingest.js";
import { sync } from "./modules/banks/sync.js";
import * as categories from "./shared/categories.js";
import * as db from "./shared/db.js";
import { withPayCalendar } from "./shared/months.js";
import { parseIso } from "./shared/utils/python.js";

/** Mondays from 09:00 local time, once per ISO week. */
async function weeklyReadDue(): Promise<boolean> {
  const now = clock.localNow();
  if (!(await ai.available()) || now.weekday !== 0 || now.hour < 9) return false;
  return db.connect(async (conn) => {
    const read = await db.getMeta(conn, "weekly_read");
    const settings = (await db.getMeta(conn, "settings")) || {};
    if (!(settings.weekly_read ?? true)) return false;
    if (!read?.created_at) return true;
    // The week it was made in, as stored (UTC), like the Python app.
    const [y, w] = clock.wallClock(parseIso(read.created_at), "UTC").date.isocalendar();
    const [ny, nw] = now.date.isocalendar();
    return y !== ny || w !== nw;
  });
}

let started = false;

/** Background loop, for each active person: sync every SYNC_HOURS (banks allow about 4 unattended fetches a day),
 * then cool-down alerts, and the weekly read on Monday mornings. */
export function runScheduler() {
  // The demo's banks are made up: nothing to sync, no alerts to send. EBBY_SCHEDULER=off keeps tests' data still.
  if (config.DEMO || started || !config.SCHEDULER) return;
  started = true;

  const forUser = async () => {
    const last = await db.connect(async (conn) => {
      if ((await db.getMeta(conn, "categories_version")) !== categories.VERSION) {
        await ingest.recategorize(conn);  // categories changed since this history was sorted
        await db.setMeta(conn, "categories_version", categories.VERSION);
      }
      return db.getMeta(conn, "last_attempt");
    });
    const due = !last || parseIso(last).getTime() < clock.now().getTime() - config.SYNC_HOURS * 3600_000;
    if (due) await sync();
    // Also flushes alerts held back during quiet hours.
    await alerts.check();
    if (await weeklyReadDue()) {
      let read = null;
      try {
        read = await ai.weeklyRead();
      } catch (e) {
        if (e instanceof aiUsage.BudgetExceeded || e instanceof aiUsage.NoAPIKey) console.info(`no weekly read for user ${db.currentUser()}: ${e.message}`);
        else throw e;
      }
      if (read) await push.send("Your week", read.headline, "/", "weekly-read");
    }
  };

  const oneRound = async () => {
    let users: number[] = [];
    try { users = await db.activeUsers(); } catch (e) { console.error("couldn't list users", e); }
    for (const userId of users) {
      try {
        await db.asUser(userId, () => withPayCalendar(forUser));
      } catch (e) {  // e.g. the key file is missing; log it and keep the loop alive
        console.error(`scheduled work failed for user ${userId}`, e);
      }
    }
  };

  const loop = async () => {
    // Every pod runs this loop; one round at a time across them, so each sees what the last wrote (last_attempt,
    // alerts sent) and nothing is fetched or sent twice.
    try {
      await db.advisoryLock(db.LOCK_SCHEDULER, 0, async (mine) => { if (mine) await oneRound(); });
    } catch (e) {
      console.error("scheduler round failed", e);
    }
    setTimeout(loop, 300_000).unref();
  };
  void loop();
}

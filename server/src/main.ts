/**
 * ebby's server and its commands.
 *
 *   ebby serve                 migrate, start the scheduler, serve on PORT (8000)
 *   ebby demo-seed [EMAIL]     fill a made-up person's six months of spending (default demo@spending.local)
 *   ebby add-user EMAIL [--admin]
 */

import { serve } from "@hono/node-server";

import { config, ConfigError, validateConfig } from "./config.js";
import * as db from "./shared/db.js";
import * as users from "./modules/account/repo.js";
import * as demo from "./modules/demo/seed.js";
import { createApp } from "./server.js";
import { runScheduler } from "./scheduler.js";

async function startup() {
  await db.init();
  if (config.ADMIN_EMAIL && (await db.adminId()) == null) await users.ensureUser(config.ADMIN_EMAIL, true);
}

async function main(args: string[]) {
  const [cmd = "serve", ...rest] = args;
  validateConfig({ database: true });
  if (cmd === "serve") {
    await startup();
    runScheduler();
    serve({ fetch: createApp().fetch, port: config.PORT, hostname: "0.0.0.0" }, (info) => console.info(`ebby listening on :${info.port}`));
    return;
  }
  if (cmd === "demo-seed") {
    await db.init();
    console.info(JSON.stringify(await demo.seed(rest[0] ?? demo.EMAIL)));
  } else if (cmd === "add-user") {
    if (!rest[0]) throw new Error("usage: ebby add-user EMAIL [--admin]");
    await db.init();
    console.info(`user ${await users.ensureUser(rest[0], rest.includes("--admin"))}`);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exitCode = 2;
  }
  await db.close();
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e instanceof ConfigError ? e.message : e);
  process.exit(1);
});

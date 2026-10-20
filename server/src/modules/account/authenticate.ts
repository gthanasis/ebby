/** Who a request acts as: the sign-in method is picked once, from the settings, when the app is built. */

import type { Context } from "hono";

import { config, secrets } from "../../config.js";
import * as db from "../../shared/db.js";
import { currentUser, originOk } from "./auth.js";
import type { AuthStore } from "./repo.js";

/** The person's id, or the response that turns the request away. */
export type Authenticate = (c: Context) => Promise<number | Response>;

const noUsers = (c: Context) => c.text("No users yet: set ADMIN_EMAIL or run `ebby add-user EMAIL --admin`.", 503);

async function asAdmin(c: Context): Promise<number | Response> {
  return (await db.adminId()) ?? noUsers(c);
}

const google = (store: AuthStore): Authenticate => async (c) => {
  const user = await currentUser(c, store);
  if (!user) return c.json({ detail: "Sign in first." }, 401);
  if (!originOk(c)) return c.json({ detail: "That request didn't come from this app." }, 403);
  return user.id;
};

const basic: Authenticate = async (c) => {
  const header = c.req.header("authorization") ?? "";
  const decoded = header.startsWith("Basic ") ? Buffer.from(header.slice(6), "base64").toString() : null;
  if (decoded === null || decoded.slice(decoded.indexOf(":") + 1) !== secrets.APP_PASSWORD) {
    return c.body(null, 401, { "WWW-Authenticate": 'Basic realm="ebby"' });
  }
  return asAdmin(c);
};

// Local runs without any login act as the admin.
const localAdmin: Authenticate = asAdmin;

// Public and no sign-in configured: acting as the admin would hand anyone their money.
const refuse: Authenticate = async (c) =>
  c.text("No sign-in configured: set GOOGLE_CLIENT_ID (or APP_PASSWORD for a private install).", 503);

export function authenticator(store: AuthStore): Authenticate {
  if (config.GOOGLE_CLIENT_ID) return google(store);
  if (secrets.APP_PASSWORD) return basic;
  if (config.LOCAL) return localAdmin;
  return refuse;
}

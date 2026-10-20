/**
 * Google sign-in limited to the people in the users table, with server-side sessions.
 *
 * The session cookie holds 32 random bytes; only their sha256 is stored, so a leaked database row can't be replayed
 * as a cookie. The same cookies as the Python app, so nobody is signed out by the switch.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";

import * as clock from "../../shared/clock.js";
import { config, secrets } from "../../config.js";
import type { AuthStore } from "./repo.js";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export const SESSION_COOKIE = "session";
const SESSION_DAYS = 30;
const FLOW_COOKIE = "oauth_flow";
const FLOW_SECONDS = 600;

const redirectUri = () => `${config.PUBLIC_URL}/auth/callback`;
const secure = () => !config.PUBLIC_URL.startsWith("http://localhost");
const b64 = (data: Buffer) => data.toString("base64url");

function sign(payload: Record<string, unknown>): string {
  const body = b64(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64(createHmac("sha256", secrets.SESSION_SECRET).update(body).digest())}`;
}

/** The payload of a cookie we signed that hasn't expired, else null. */
function unsign(value: string): Record<string, any> | null {
  const i = value.indexOf(".");
  const body = i === -1 ? value : value.slice(0, i), mac = i === -1 ? "" : value.slice(i + 1);
  const expected = createHmac("sha256", secrets.SESSION_SECRET).update(body).digest();
  try {
    const got = Buffer.from(mac, "base64url");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    return (payload.exp ?? 0) > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest();

/** Claims of a Google ID token meant for us, or throws. */
async function verifyIdToken(idToken: string): Promise<Record<string, any>> {
  const { payload } = await jwtVerify(idToken, JWKS, { algorithms: ["RS256"], audience: config.GOOGLE_CLIENT_ID, requiredClaims: ["exp", "iss", "aud", "email"] });
  if (!ISSUERS.includes(String(payload.iss))) throw new Error(`issuer ${payload.iss}`);
  if (payload.email_verified !== true) throw new Error("email not verified");
  return payload;
}

export async function currentUser(c: Context, store: AuthStore) {
  const token = getCookie(c, SESSION_COOKIE);
  return token ? store.sessionUser(hashToken(token)) : null;
}

/** CSRF check on top of SameSite=Lax: writes must come from our own pages. */
export function originOk(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD") return true;
  const origin = c.req.header("origin");
  if (!origin) return false;
  const proto = (c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "")).split(",")[0].trim();
  const host = c.req.header("x-forwarded-host") || c.req.header("host") || "";
  return origin === `${proto}://${host.split(",")[0].trim()}`;
}

function failed(c: Context, reason: string) {
  console.warn(`sign-in failed: ${reason}`);
  deleteCookie(c, FLOW_COOKIE, { path: "/auth" });
  return c.redirect("/#/login/error=failed", 302);
}

export function router(store: AuthStore): Hono {
  const r = new Hono();

  r.get("/auth/google", (c) => {
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    const challenge = b64(createHash("sha256").update(verifier).digest());
    const query = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(), response_type: "code",
      scope: "openid email profile", state, prompt: "select_account", code_challenge: challenge, code_challenge_method: "S256",
    });
    setCookie(c, FLOW_COOKIE, sign({ state, verifier, exp: Date.now() / 1000 + FLOW_SECONDS }),
      { maxAge: FLOW_SECONDS, path: "/auth", httpOnly: true, secure: secure(), sameSite: "Lax" });
    return c.redirect(`${AUTHORIZE_URL}?${query}`, 302);
  });

  r.get("/auth/callback", async (c) => {
    const code = c.req.query("code") ?? "", state = c.req.query("state") ?? "", error = c.req.query("error") ?? "";
    if (error) return failed(c, `google said ${error}`);
    const flow = unsign(getCookie(c, FLOW_COOKIE) ?? "");
    const want = Buffer.from(String(flow?.state ?? "")), got = Buffer.from(state);
    if (!flow || !code || want.length !== got.length || !timingSafeEqual(want, got)) return failed(c, "missing or mismatched state");
    let claims;
    try {
      const resp = await fetch(TOKEN_URL, { method: "POST", signal: AbortSignal.timeout(15_000), body: new URLSearchParams({
        code, client_id: config.GOOGLE_CLIENT_ID, client_secret: secrets.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri(), grant_type: "authorization_code", code_verifier: flow.verifier,
      }) });
      if (!resp.ok) throw new Error(`${resp.status} from the token endpoint`);
      claims = await verifyIdToken((await resp.json()).id_token);
    } catch (e) {
      return failed(c, String((e as Error)?.message ?? e));
    }
    const email = String(claims.email).toLowerCase();
    const user = await store.userByEmail(email);
    if (!user || !["invited", "active"].includes(user.status)) {
      console.warn(`sign-in refused for ${email}`);
      deleteCookie(c, FLOW_COOKIE, { path: "/auth" });
      return c.redirect(`/#/login/error=not_allowed&email=${encodeURIComponent(email)}`, 302);
    }
    if (user.status === "invited") await store.activate(user.id, claims.name ?? null, claims.picture ?? null);
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(clock.now().getTime() + SESSION_DAYS * 86_400_000);
    await store.createSession(user.id, hashToken(token), expires, c.req.header("user-agent") ?? null);
    deleteCookie(c, FLOW_COOKIE, { path: "/auth" });
    setCookie(c, SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86400, path: "/", httpOnly: true, secure: secure(), sameSite: "Lax" });
    return c.redirect("/", 302);
  });

  r.post("/auth/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await store.deleteSession(hashToken(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/", httpOnly: true, secure: secure(), sameSite: "Lax" });
    return c.redirect("/#/login/signed_out=1", 303);
  });

  return r;
}

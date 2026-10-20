/** Web push to the installed app (iPhone needs it on the home screen, iOS 16.4+). */

import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import webpush from "web-push";

import * as clock from "../clock.js";
import { config, secrets } from "../config.js";
import * as db from "../data/db.js";
import * as pushRepo from "../data/repos/push_subscriptions.js";
import { isoUtc, pyDumps } from "../utils/python.js";

const keyFile = () => join(config.DATA_DIR, "vapid.pem");

/** The VAPID private key as PEM: from the environment, else the file next to the data (made once). */
function vapidPem(): string {
  if (secrets.VAPID_PRIVATE_KEY) return secrets.VAPID_PRIVATE_KEY.replaceAll("\\n", "\n");
  if (!existsSync(keyFile())) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    mkdirSync(config.DATA_DIR, { recursive: true });
    writeFileSync(keyFile(), privateKey.export({ type: "pkcs8", format: "pem" }));
    chmodSync(keyFile(), 0o600);
  }
  return readFileSync(keyFile(), "utf8");
}

/** The key pair as web-push wants it: base64url raw points. */
function vapidKeys(): { publicKey: string; privateKey: string } {
  const key = createPrivateKey(vapidPem());
  const jwk = key.export({ format: "jwk" });
  const pub = createPublicKey(key).export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, "base64url"), Buffer.from(pub.y!, "base64url")]);
  return { publicKey: raw.toString("base64url"), privateKey: jwk.d! };
}

/** The applicationServerKey the browser subscribes with (uncompressed point, base64url). */
export const publicKey = () => vapidKeys().publicKey;

export async function subscribe(subscription: { endpoint: string }) {
  await db.connect((conn) => pushRepo.upsert(conn, subscription.endpoint, pyDumps(subscription), isoUtc(clock.now())));
}

export async function unsubscribe(endpoint: string) {
  await db.connect((conn) => pushRepo.remove(conn, endpoint));
}

export async function count(): Promise<number> {
  return db.connect((conn) => pushRepo.count(conn));
}

/** Sends to every subscribed device; drops subscriptions the push service says are gone. */
export async function send(title: string, body: string, url = "/", tag: string | null = null): Promise<number> {
  const subs = (await db.connect((conn) => pushRepo.all(conn))).map((s) => JSON.parse(s));
  if (!subs.length) return 0;
  const { publicKey: pub, privateKey } = vapidKeys();
  const payload = pyDumps({ title, body, url, tag });
  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload, { vapidDetails: { subject: config.VAPID_SUBJECT, publicKey: pub, privateKey }, TTL: 60 * 60 * 12 });
      sent += 1;
    } catch (e: any) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) await unsubscribe(sub.endpoint);
      console.warn(`push failed (${status}): ${e?.body ?? e}`);
    }
  }
  return sent;
}

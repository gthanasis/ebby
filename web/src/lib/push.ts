import { request } from "./api";

/** iPhone only allows web push for apps added to the home screen (iOS 16.4+). */
export function pushSupport(): "ok" | "install" | "unsupported" {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return ios ? "install" : "unsupported";
  }
  return "ok";
}

function keyBytes(base64url: string) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (pushSupport() !== "ok") return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

/** Must run from a tap: browsers only show the permission prompt in response to a gesture. */
export async function enablePush(): Promise<number> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in your phone's settings for Spending.");
  const reg = await navigator.serviceWorker.ready;
  const { key } = await request<{ key: string }>("/api/push/key");
  const sub = (await reg.pushManager.getSubscription())
    ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  const res = await request<{ devices: number }>("/api/push/subscribe", { method: "POST", body: JSON.stringify(sub.toJSON()) });
  return res.devices;
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await request("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}

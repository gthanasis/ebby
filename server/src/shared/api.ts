/**
 * The app's own API, called from inside the server for the person already signed in: the assistant reads what any
 * screen reads and drafts what any screen changes through the same routes, so it sees the numbers the way the app
 * shows them and its changes pass the same checks. server.ts attaches the routes; the caller's user and pay calendar
 * carry over.
 */

import { rehearsal } from "./http.js";

type Fetch = (request: Request) => Response | Promise<Response>;
let routes: Fetch | null = null;

export function attach(fetch: Fetch) { routes = fetch; }

export interface Answer { status: number; data: unknown }

/** One request. mode "describe" answers with the body's JSON schema and "check" with the body as it would run, both
 * without changing anything: only for routes that read a body, as one that doesn't would simply run. */
export async function call(method: string, path: string, body?: unknown, mode?: "describe" | "check"): Promise<Answer> {
  if (!routes) throw new Error("The API isn't attached");
  const send = body !== undefined && body !== null && mode !== "describe";
  const request = new Request(new URL(path, "http://ebby.internal"), {
    method, headers: send ? { "content-type": "application/json" } : {}, body: send ? JSON.stringify(body) : undefined,
  });
  const run = async (): Promise<Answer> => {
    const response = await routes!(request);
    const text = await response.text();
    try { return { status: response.status, data: JSON.parse(text) }; } catch { return { status: response.status, data: text }; }
  };
  return mode ? rehearsal.run(mode, run) : run();
}

/** "PUT /api/commitments/:cid" as a pattern for a method and path ("PUT", "/api/commitments/9?x=1"). */
export function routeMatcher(route: string): (method: string, path: string) => boolean {
  const [verb, pattern] = route.split(" ");
  const re = new RegExp(`^${pattern.replace(/:[a-zA-Z]+\{\.\+\}/g, ".+").replace(/:[a-zA-Z]+/g, "[^/?]+")}$`);
  return (method, path) => method.toUpperCase() === verb && re.test(path.split("?")[0]);
}

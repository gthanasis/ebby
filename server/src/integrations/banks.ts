/**
 * The banks a person can connect: every one Enable Banking supports in the country, for personal accounts.
 *
 * Enable Banking answers with what the asking application can reach: a sandbox app gets Mock ASPSP and friends, a
 * production app the real banks. So the list is kept a day per application, never shared between people. In
 * restricted mode a bank only works if its accounts are linked to that application.
 */

import { config } from "../config.js";
import * as credentials from "./credentials.js";
import { floorDiv, sorted } from "../utils/python.js";

const DAY_MS = 24 * 3600 * 1000;
// What Enable Banking listed for Greece (personal accounts) in October 2026, for the demo, which has no app of its own.
const DEMO_BANKS = ["Airwallex", "Alpha Bank", "bunq", "Credia Bank", "DiPocket", "Epirus Bank", "Eurobank", "Genome", "iBanFirst",
  "N26", "National Bank of Greece", "Optima bank", "PayPal", "Piraeus Bank", "Revolut", "Snappi", "Trade Republic", "Wise"];
export const _cache = new Map<string, [number, Bank[]]>();

export interface Bank { name: string; logo: string | null; beta: boolean; consent_days: number | null }

/** Python's urllib.parse.quote: like encodeURIComponent, but "/" kept and !'()* escaped. */
const quote = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll("%2F", "/");

/** Sorted by name. Throws credentials.MissingCredential before the person has given the app their Enable Banking
 * keys, EnableBankingError if it can't be reached. */
export async function available(): Promise<Bank[]> {
  if (config.DEMO) {
    return sorted(DEMO_BANKS, (n) => n.toLowerCase()).map((n) => ({ name: n, logo: `https://enablebanking.com/brands/GR/${quote(n)}/`, beta: true, consent_days: 180 }));
  }
  const client = await credentials.client();
  const key = `${client.appId}:${config.COUNTRY}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit[0] < DAY_MS) return hit[1];
  const banks = sorted((await client.aspsps(config.COUNTRY))
    .filter((b) => (b.psu_types || ["personal"]).includes("personal"))
    .map((b) => ({ name: b.name, logo: b.logo ?? null, beta: Boolean(b.beta), consent_days: floorDiv(parseInt(b.maximum_consent_validity || 0, 10), 86400) || null })),
  (b) => b.name.toLowerCase());
  _cache.set(key, [Date.now(), banks]);
  return banks;
}

export async function find(name: string): Promise<Bank | null> {
  return (await available()).find((b) => b.name === name) ?? null;
}

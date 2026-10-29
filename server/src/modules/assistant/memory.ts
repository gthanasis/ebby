/** What the assistant remembers: lines the person wrote or agreed to, read when it guesses a category and when it
 * chats. Nothing goes in without the person saying so. */

import * as clock from "../../shared/clock.js";
import * as db from "../../shared/db.js";
import type { Conn } from "../../shared/db.js";
import { fail } from "../../shared/http.js";
import { isoUtc } from "../../shared/utils/python.js";
import { type MemoryLine, toMemoryLine } from "./converters.js";
import * as memoryRepo from "./memory_repo.js";

const GUESS_KEY = "sorter_guesses";

export const list = async (conn: Conn): Promise<MemoryLine[]> => (await memoryRepo.all(conn)).map(toMemoryLine);

/** Keeps a line. Guesses already made for its payee (or every guess, for a line about no payee) are dropped, so the
 * next one reads it. */
export async function remember(conn: Conn, text: string, source: "you" | "payment" | "chat", service: string | null = null): Promise<MemoryLine[]> {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) fail(400, "Write what the assistant should remember");
  if (clean.length > 300) fail(400, "Keep it to a sentence or two");
  await memoryRepo.add(conn, { text: clean, source, service, created_at: isoUtc(clock.now(), "seconds") });
  const guesses = (await db.getMeta(conn, GUESS_KEY)) || {};
  if (service) delete guesses[service];
  await db.setMeta(conn, GUESS_KEY, service ? guesses : {});
  return list(conn);
}

export async function edit(conn: Conn, id: number, text: string): Promise<MemoryLine[]> {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) fail(400, "Write what the assistant should remember, or forget the line");
  if (!(await memoryRepo.update(conn, id, clean))) fail(404, "No such line");
  return list(conn);
}

export async function forget(conn: Conn, id: number): Promise<MemoryLine[]> {
  await memoryRepo.remove(conn, id);
  return list(conn);
}

/** The lines as the prompts read them, numbered by id so a guess can say which it used. */
export async function promptLines(conn: Conn): Promise<{ text: string; ids: number[] }> {
  const rows = await memoryRepo.all(conn);
  return { text: rows.map((r) => `[${r.id}] ${r.text}${r.service ? ` (said about ${r.service})` : ""}`).join("\n"), ids: rows.map((r) => r.id) };
}

export const markUsed = memoryRepo.markUsed;

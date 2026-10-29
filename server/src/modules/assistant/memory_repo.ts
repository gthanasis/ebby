/** The assistant_memory table: what someone asked the assistant to remember, a line each. */

import type { Selectable } from "kysely";

import type { Conn } from "../../shared/db.js";
import type { AssistantMemory } from "../../types/db.js";

export type MemoryRow = Selectable<AssistantMemory>;

/** Every line, newest first. */
export const all = (conn: Conn): Promise<MemoryRow[]> =>
  conn.db.selectFrom("assistant_memory").selectAll().orderBy("id", "desc").execute();

export async function add(conn: Conn, m: { text: string; source: string; service: string | null; created_at: string }): Promise<number> {
  return (await conn.db.insertInto("assistant_memory").values(m).returning("id").executeTakeFirstOrThrow()).id;
}

export async function update(conn: Conn, id: number, text: string): Promise<boolean> {
  return Number((await conn.db.updateTable("assistant_memory").set({ text }).where("id", "=", id).executeTakeFirst()).numUpdatedRows) > 0;
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("assistant_memory").where("id", "=", id).execute();
}

export async function markUsed(conn: Conn, ids: number[]) {
  if (ids.length) await conn.db.updateTable("assistant_memory").set((eb) => ({ used: eb("used", "+", 1) })).where("id", "in", ids).execute();
}

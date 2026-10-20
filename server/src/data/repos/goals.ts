/** The goals table: things to buy and totals to save. */

import type { Conn } from "../db.js";
import type { Goal } from "../../types/entities.js";

export const all = (conn: Conn): Promise<Goal[]> =>
  conn.db.selectFrom("goals").selectAll().orderBy("target_date").execute();

export const get = (conn: Conn, id: number): Promise<Goal | undefined> =>
  conn.db.selectFrom("goals").selectAll().where("id", "=", id).executeTakeFirst();

export async function hasSavingsTotal(conn: Conn): Promise<boolean> {
  return Boolean(await conn.db.selectFrom("goals").select("id").where("kind", "=", "save").executeTakeFirst());
}

export async function add(conn: Conn, g: Pick<Goal, "name" | "price" | "saved" | "target_date" | "created_at" | "kind">) {
  await conn.db.insertInto("goals").values(g).execute();
}

export async function update(conn: Conn, id: number, g: Pick<Goal, "name" | "price" | "saved" | "target_date">) {
  await conn.db.updateTable("goals").set(g).where("id", "=", id).execute();
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("goals").where("id", "=", id).execute();
}

/** The goals table: things to buy and totals to save. */

import type { Conn } from "../../shared/db.js";
import type { Goal } from "../../types/entities.js";

export const all = (conn: Conn): Promise<Goal[]> =>
  conn.db.selectFrom("goals").selectAll().orderBy("target_date").execute();

export const get = (conn: Conn, id: number): Promise<Goal | undefined> =>
  conn.db.selectFrom("goals").selectAll().where("id", "=", id).executeTakeFirst();

export async function hasSavingsTotal(conn: Conn): Promise<boolean> {
  return Boolean(await conn.db.selectFrom("goals").select("id").where("kind", "=", "save").executeTakeFirst());
}

/** Adds a goal; without a kind it's a thing to buy. */
export async function add(conn: Conn, g: Pick<Goal, "name" | "price" | "saved" | "target_date" | "created_at"> & Partial<Pick<Goal, "kind">>) {
  await conn.db.insertInto("goals").values(g).execute();
}

export async function update(conn: Conn, id: number, g: Pick<Goal, "name" | "price" | "saved" | "target_date">) {
  await conn.db.updateTable("goals").set(g).where("id", "=", id).execute();
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("goals").where("id", "=", id).execute();
}

export const nameOf = (conn: Conn, id: number): Promise<Pick<Goal, "id" | "name"> | undefined> =>
  conn.db.selectFrom("goals").select(["id", "name"]).where("id", "=", id).executeTakeFirst();

/** What each goal costs and has saved, by target date. */
export const progress = (conn: Conn): Promise<Pick<Goal, "id" | "name" | "price" | "saved" | "target_date">[]> =>
  conn.db.selectFrom("goals").select(["id", "name", "price", "saved", "target_date"]).orderBy("target_date").orderBy("id").execute();

/** Adds to what a goal has saved (a negative amount takes away), never below zero. */
export async function addSaved(conn: Conn, id: number, amount: number) {
  await conn.execute("UPDATE goals SET saved = GREATEST(0, saved + ?) WHERE id = ?", [amount, id]);
}

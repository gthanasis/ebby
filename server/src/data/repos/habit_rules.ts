/** The habit_rules table. */

import { first, type Conn } from "../db.js";
import type { HabitRule } from "../../types/entities.js";

export const all = (conn: Conn): Promise<HabitRule[]> =>
  conn.db.selectFrom("habit_rules").selectAll().orderBy("created_at").orderBy("id").execute();

export const get = (conn: Conn, id: number): Promise<HabitRule | undefined> =>
  conn.db.selectFrom("habit_rules").selectAll().where("id", "=", id).executeTakeFirst();

export async function setTarget(conn: Conn, id: number, target: number) {
  await conn.db.updateTable("habit_rules").set({ target }).where("id", "=", id).execute();
}

export async function setGoal(conn: Conn, id: number, goalId: number | null) {
  await conn.db.updateTable("habit_rules").set({ goal_id: goalId }).where("id", "=", id).execute();
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("habit_rules").where("id", "=", id).execute();
}

/** Adds a habit; returns its id. */
export async function add(conn: Conn, h: Pick<HabitRule, "type" | "category" | "target" | "baseline" | "goal_id" | "created_at">): Promise<number> {
  await conn.execute("INSERT INTO habit_rules(type, category, target, baseline, goal_id, created_at) VALUES(?, ?, ?, ?, ?, ?)",
    [h.type, h.category, h.target, h.baseline, h.goal_id, h.created_at]);
  return first((await conn.execute("SELECT lastval()")).one());
}

/** The habit_rules table. */

import type { Conn } from "../db.js";
import type { HabitRule } from "../../types/entities.js";

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

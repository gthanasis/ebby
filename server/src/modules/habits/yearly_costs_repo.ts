/** The yearly_costs table. */

import type { Conn } from "../../shared/db.js";
import type { YearlyCost } from "../../types/entities.js";

export const all = (conn: Conn): Promise<YearlyCost[]> =>
  conn.db.selectFrom("yearly_costs").selectAll().orderBy("due_month").execute();

export async function add(conn: Conn, y: Pick<YearlyCost, "name" | "yearly_amount" | "due_month" | "created_at">) {
  await conn.db.insertInto("yearly_costs").values(y).execute();
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("yearly_costs").where("id", "=", id).execute();
}

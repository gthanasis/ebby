/** The commitments table, as written: services stay the JSON text the Python app stored. */

import type { Conn } from "../db.js";
import type { Insertable, Selectable } from "kysely";
import type { Commitments } from "../../types/db.js";

export type CommitmentFields = Omit<Insertable<Commitments>, "id" | "user_id" | "created_at">;

/** Every commitment, by kind and name, services as stored (JSON text). */
export const all = (conn: Conn): Promise<Selectable<Commitments>[]> =>
  conn.db.selectFrom("commitments").selectAll().orderBy("kind").orderBy("name").execute();

export async function exists(conn: Conn, id: number): Promise<boolean> {
  return Boolean(await conn.db.selectFrom("commitments").select("id").where("id", "=", id).executeTakeFirst());
}

export async function add(conn: Conn, c: CommitmentFields & { created_at: string }) {
  await conn.db.insertInto("commitments").values(c).execute();
}

export async function update(conn: Conn, id: number, c: CommitmentFields) {
  await conn.db.updateTable("commitments").set(c).where("id", "=", id).execute();
}

export async function remove(conn: Conn, id: number) {
  await conn.db.deleteFrom("commitments").where("id", "=", id).execute();
}

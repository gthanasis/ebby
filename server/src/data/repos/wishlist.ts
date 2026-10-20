/** The wishlist table: things to wait 48 hours on before buying. */

import { first, type Conn } from "../db.js";
import type { Wish } from "../../types/entities.js";

/** Wishes not decided on yet, oldest first. */
export const undecided = (conn: Conn): Promise<Wish[]> =>
  conn.db.selectFrom("wishlist").selectAll().where("decision", "is", null).orderBy("created_at").execute();

/** What was skipped since a moment, in euros. */
export async function skippedSince(conn: Conn, since: string): Promise<number> {
  return first((await conn.execute("SELECT COALESCE(SUM(price), 0) FROM wishlist WHERE decision = 'skipped' AND decided_at >= ?", [since])).one());
}

/** Prices of the wishes bought in [from, to). */
export async function boughtPrices(conn: Conn, from: string, to: string): Promise<number[]> {
  return (await conn.execute<{ price: number }>("SELECT price FROM wishlist WHERE decision = 'bought' AND decided_at >= ? AND decided_at < ?",
    [from, to])).rows.map((r) => r.price);
}

/** Adds a wish; returns its id. */
export async function add(conn: Conn, name: string, price: number, createdAt: string): Promise<number> {
  await conn.execute("INSERT INTO wishlist(name, price, created_at) VALUES(?, ?, ?)", [name, price, createdAt]);
  return first((await conn.execute("SELECT lastval()")).one());
}

/** Records a decision, unless one was made already. */
export async function decide(conn: Conn, id: number, decision: string, decidedAt: string) {
  await conn.execute("UPDATE wishlist SET decision = ?, decided_at = ? WHERE id = ? AND decision IS NULL", [decision, decidedAt, id]);
}

export async function markReminded(conn: Conn, ids: number[]) {
  await conn.execute(`UPDATE wishlist SET reminded = 1 WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
}

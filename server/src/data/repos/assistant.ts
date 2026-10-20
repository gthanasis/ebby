/** The assistant_actions and assistant_messages tables: the chat, and the changes it proposed. */

import { first, type Conn } from "../db.js";
import type { AssistantAction } from "../../types/entities.js";

/** Stores a proposed change; returns its id. */
export async function addAction(conn: Conn, conversation: number, kind: string, params: string, summary: string, createdAt: string): Promise<number> {
  await conn.execute("INSERT INTO assistant_actions(conversation, kind, params, summary, created_at) VALUES(?, ?, ?, ?, ?)",
    [conversation, kind, params, summary, createdAt]);
  return first((await conn.execute("SELECT lastval()")).one());
}

export const action = (conn: Conn, id: number): Promise<AssistantAction | undefined> =>
  conn.db.selectFrom("assistant_actions").selectAll().where("id", "=", id).executeTakeFirst();

export const pendingAction = (conn: Conn, id: number): Promise<AssistantAction | undefined> =>
  conn.db.selectFrom("assistant_actions").selectAll().where("id", "=", id).where("status", "=", "pending").executeTakeFirst();

export const actions = (conn: Conn, conversation: number): Promise<Pick<AssistantAction, "id" | "kind" | "params" | "summary" | "status">[]> =>
  conn.db.selectFrom("assistant_actions").select(["id", "kind", "params", "summary", "status"]).where("conversation", "=", conversation).execute();

export async function setActionStatus(conn: Conn, id: number, status: string) {
  await conn.db.updateTable("assistant_actions").set({ status }).where("id", "=", id).execute();
}

/** Marks a conversation's unconfirmed proposals expired. */
export async function expirePending(conn: Conn, conversation: number) {
  await conn.db.updateTable("assistant_actions").set({ status: "expired" })
    .where("conversation", "=", conversation).where("status", "=", "pending").execute();
}

export async function addMessage(conn: Conn, conversation: number, role: string, content: string, createdAt: string) {
  await conn.db.insertInto("assistant_messages").values({ conversation, role, content, created_at: createdAt }).execute();
}

/** A conversation's messages in order, content as stored (JSON). */
export const messages = (conn: Conn, conversation: number): Promise<{ role: string; content: string }[]> =>
  conn.db.selectFrom("assistant_messages").select(["role", "content"]).where("conversation", "=", conversation).orderBy("id").execute();

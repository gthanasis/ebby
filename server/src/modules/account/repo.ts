/**
 * People: the allow list, sign-in sessions, and the admin's view of them.
 *
 * These tables have no row-level security (they're how a request finds its user), so everything here runs through
 * db.connectSystem() and never touches anyone's own rows.
 */

import * as clock from "../../shared/clock.js";
import { pyRound } from "../../shared/utils/python.js";
import * as db from "../../shared/db.js";
import type { Row } from "../../shared/db.js";
import type { User } from "../../types/entities.js";

/** Someone on the list, without their dates. */
export type Listed = Omit<User, "created_at" | "last_login_at">;

export interface AuthStore {
  userByEmail(email: string): Promise<Row | null>;
  activate(userId: number, name: string | null, picture: string | null): Promise<void>;
  createSession(userId: number, tokenHash: Buffer, expiresAt: Date, userAgent: string | null): Promise<void>;
  sessionUser(tokenHash: Buffer): Promise<Row | null>;
  deleteSession(tokenHash: Buffer): Promise<void>;
}

/** The sign-in store on Postgres. */
export class Store implements AuthStore {
  userByEmail(email: string) { return db.userByEmail(email); }

  async activate(userId: number, name: string | null, picture: string | null) {
    await db.connectSystem((conn) => conn.execute("UPDATE users SET status = 'active', name = ?, picture = ? WHERE id = ? AND status = 'invited'",
      [name, picture, userId]));
  }

  async createSession(userId: number, tokenHash: Buffer, expiresAt: Date, userAgent: string | null) {
    await db.connectSystem(async (conn) => {
      await conn.execute("INSERT INTO sessions(token_hash, user_id, expires_at, user_agent) VALUES(?, ?, ?, ?)", [tokenHash, userId, expiresAt, userAgent]);
      await conn.execute("UPDATE users SET last_login_at = now() WHERE id = ?", [userId]);
      await conn.execute("DELETE FROM sessions WHERE expires_at < now()");
    });
  }

  async sessionUser(tokenHash: Buffer): Promise<Row | null> {
    return db.connectSystem(async (conn) => {
      const row = (await conn.execute(`
        SELECT u.id, u.email, u.name, u.picture, u.status, u.is_admin, s.extended_at FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > now() AND u.status = 'active'
      `, [tokenHash])).one();
      if (!row) return null;
      if (new Date(row.extended_at).getTime() < clock.now().getTime() - 86_400_000) {
        await conn.execute("UPDATE sessions SET expires_at = now() + interval '30 days', extended_at = now() WHERE token_hash = ?", [tokenHash]);
      }
      const { extended_at: _, ...user } = row;
      return user;
    });
  }

  async deleteSession(tokenHash: Buffer) {
    await db.connectSystem((conn) => conn.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]));
  }
}

export async function me(userId: number): Promise<Listed> {
  return db.connectSystem(async (conn) => (await conn.execute<Listed>(
    "SELECT id, email, name, picture, is_admin, status, ai_budget_usd FROM users WHERE id = ?", [userId])).one()!);
}

/** The admin's list: everyone on it and what they spent on AI since `since`. No one's own data. */
export async function people(since: Date): Promise<(User & { ai_spent_usd: number })[]> {
  return db.connectSystem(async (conn) => {
    const spent = new Map((await conn.execute("SELECT * FROM admin_ai_usage(?)", [since])).rows.map((r) => [r.user_id, r.cost_usd]));
    const rows = (await conn.execute<User>(`SELECT id, email, name, picture, is_admin, status, ai_budget_usd, created_at, last_login_at
                                      FROM users ORDER BY created_at`)).rows;
    return rows.map((r) => ({ ...r, ai_spent_usd: pyRound(spent.get(r.id) ?? 0.0, 2) }));
  });
}

export async function invite(emailIn: string, aiBudgetUsd: number | null = null): Promise<Listed> {
  const email = emailIn.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("That isn't an email address.");
  const row = await db.connectSystem(async (conn) => (await conn.execute(`
    INSERT INTO users(email, ai_budget_usd, created_at) VALUES(?, COALESCE(?::double precision, 2), ?) ON CONFLICT(email) DO NOTHING
    RETURNING id
  `, [email, aiBudgetUsd, clock.now()])).one());
  if (!row) throw new Error(`${email} is already on the list.`);
  return me(row.id);
}

export async function update(userId: number, fields: { status?: string | null; aiBudgetUsd?: number | null }) {
  await db.connectSystem(async (conn) => {
    if (fields.status != null) {
      await conn.execute("UPDATE users SET status = ? WHERE id = ? AND NOT is_admin", [fields.status, userId]);
      if (fields.status === "disabled") await conn.execute("DELETE FROM sessions WHERE user_id = ?", [userId]);  // out at once, not at expiry
    }
    if (fields.aiBudgetUsd != null) await conn.execute("UPDATE users SET ai_budget_usd = ? WHERE id = ?", [fields.aiBudgetUsd, userId]);
  });
}

/** Adds someone to the allow list (or makes them admin), active at once. */
export async function ensureUser(email: string, admin = false): Promise<number> {
  return db.connectSystem(async (conn) => (await conn.execute(`
    INSERT INTO users(email, is_admin, status, created_at) VALUES(?, ?, 'active', ?)
    ON CONFLICT(email) DO UPDATE SET is_admin = users.is_admin OR excluded.is_admin RETURNING id
  `, [email.toLowerCase(), admin, clock.now()])).one()!.id);
}

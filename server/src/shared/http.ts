/**
 * What every route shares: errors as {"detail": ...}, bodies checked against a schema (422 when they don't fit), and
 * query parameters read as the types they are. Responses and status codes match what the Python app (FastAPI) sent.
 */

import type { Context } from "hono";
import { z } from "zod";

export class HttpError extends Error {
  constructor(readonly status: number, readonly detail: unknown) {
    super(typeof detail === "string" ? detail : "error");
  }
}

/** FastAPI's HTTPException. */
export const fail = (status: number, detail: string): never => { throw new HttpError(status, detail); };

/** What a thrown value says: an Error's message, anything else as text. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type ErrorClass = abstract new (...args: any[]) => unknown;
/** What a route turns a thrown value into: the first rule whose class it is an instance of ("*" for anything) answers
 * with that status and detail (the error's text by default), or "pass" lets it through as it is. */
export type ErrorRule = [catches: ErrorClass | "*", status: number | "pass", detail?: (e: any) => string];

/** Runs fn, answering what it throws by the rules; a value no rule catches is thrown on. */
export async function mapErrors<T>(fn: () => Promise<T>, rules: ErrorRule[]): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const rule = rules.find(([catches]) => catches === "*" || e instanceof catches);
    if (!rule || rule[1] === "pass") throw e;
    return fail(rule[1], (rule[2] ?? errorText)(e));
  }
}

function invalid(issues: { path: PropertyKey[]; message: string }[], where: string): never {
  throw new HttpError(422, issues.map((i) => ({ type: "value_error", loc: [where, ...i.path.map(String)], msg: i.message })));
}

/** The JSON body, checked against the schema. */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(422, [{ type: "json_invalid", loc: ["body"], msg: "JSON decode error" }]);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) invalid(parsed.error.issues, "body");
  return parsed.data;
}

const intText = /^\s*[+-]?\d+\s*$/;

/** An int query or path parameter: the default when absent, 422 when it isn't a whole number. */
export function int(value: string | undefined, name: string, fallback: number): number;
export function int(value: string | undefined, name: string, fallback: null): number | null;
export function int(value: string | undefined, name: string, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (!intText.test(value)) invalid([{ path: [name], message: "Input should be a valid integer" }], "query");
  return parseInt(value, 10);
}

/** A bool query parameter, read the way FastAPI does. */
export function bool(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const v = value.toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "f", "no", "n", "off"].includes(v)) return false;
  return invalid([{ path: [name], message: "Input should be a valid boolean" }], "query");
}

/** A required query parameter. */
export function required(value: string | undefined, name: string): string {
  if (value === undefined) invalid([{ path: [name], message: "Field required" }], "query");
  return value!;
}

// Pydantic's lax types: a number may arrive as a numeric string; an int as a whole float.
export const num = z.union([z.number(), z.string().regex(/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/).transform(Number)]);
export const integer = z.union([z.number().int(), z.string().regex(intText).transform((s) => parseInt(s, 10))]);
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), "Input should be a valid date");

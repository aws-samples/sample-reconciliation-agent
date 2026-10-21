/**
 * The two results an authorization gate resolves to, for tests that mock `@/lib/api-auth` and
 * `@/lib/auth/app-admin`.
 *
 * Replaces the `{ actor: "admin-1" }` literals and the `const { NextResponse } = await import(
 * "next/server"); gate.mockResolvedValue({ error: NextResponse.json({ error }, { status }) })` blocks
 * the pipeline route tests repeated for every admin-gate case.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */
import { NextResponse } from "next/server";

/** The gate admitted the caller: the actor, plus whatever else the gate reports (`isAdmin`). */
export function admitted<T extends object = Record<never, never>>(actor: string, extra?: T) {
  return { actor, ...(extra ?? ({} as T)) };
}

/** The gate refused: a response the route returns as-is. */
export function refused(status: number, error: string) {
  return { error: NextResponse.json({ error }, { status }) };
}

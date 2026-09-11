/**
 * Small response helpers shared by the `/api/pipeline` routes.
 *
 * Every error the BFF returns is `{ error: string }` with an HTTP status, so the UI has one shape to
 * render and the tests one shape to assert. Extra fields (validation `problems`, the deal a failed
 * upload left behind) ride alongside `error` rather than replacing it.
 */

import { NextResponse } from "next/server";

/** `{ error, ...extra }` with the given status. */
export function jsonError(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * The request body as a JSON object, or null when it is absent, malformed or not an object.
 *
 * Collapsing those three cases is deliberate: every caller answers all of them with the same 400,
 * and a body of `[]` or `"x"` is no more usable than no body at all.
 */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string field, or undefined. */
export function stringField(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

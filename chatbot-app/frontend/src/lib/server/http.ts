/**
 * Response helpers shared by the BFF route families (`/api/pipeline/*`, `/api/console/*`).
 *
 * Every error body is `{ error: string, ...extra }` with an HTTP status, so the UI has one shape to
 * render and the tests one shape to assert. Extra fields (validation `problems`, the deal a failed
 * upload left behind) ride alongside `error` rather than replacing it.
 *
 * Neutral on purpose: this module imports nothing from either app or from the console's own modules,
 * so the console layer and both apps can depend on it without depending on each other. The `NoStore`
 * variants exist for the console, whose answers must never be served from a browser or CDN cache
 * (a stored access group must be visible on the next request, not after a TTL); the plain variants are
 * what the app routes answer with. The recon routes still inline their envelopes.
 */

import { NextResponse } from "next/server";

/** `Cache-Control: no-store`, for answers that must not outlive the request. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** `{ error, ...extra }` with the given status. */
export function jsonError(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status });
}

/** `{ error, ...extra }` with the given status and `Cache-Control: no-store`. */
export function jsonErrorNoStore(
  status: number,
  error: string,
  extra: Record<string, unknown> = {},
): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE });
}

/** 200 (or `status`) with a JSON body and `Cache-Control: no-store`. */
export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * The request body as parsed JSON, or a marker that it could not be parsed.
 *
 * Distinguished from a parsed `null`/`undefined` by the wrapper: the validators decide what shapes
 * are acceptable, this only decides whether there was JSON at all.
 */
export async function readJson(
  req: Request,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: (await req.json()) as unknown };
  } catch {
    return { ok: false };
  }
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

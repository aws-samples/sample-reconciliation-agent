/**
 * Response helpers for the `/api/console/*` routes.
 *
 * A near-twin of `lib/pipeline/server/http.ts`, and deliberately not an import of it: the console
 * layer must not depend on an app (see `ssm.ts` for why). Every failure body is `{ error: string }`,
 * the shape the shell already renders for the proxy's 401/403, so one client-side reader covers all
 * of them.
 */

import { NextResponse } from "next/server";

import { ConsoleNotConfiguredError } from "./settings";
import { ConsoleValidationError } from "./validation";

/**
 * `no-store` on everything this layer answers.
 *
 * A stored access group or an admin's preference change must be visible on the next request, not
 * after a browser or CDN cache TTL. The GETs are what the contract requires it on; the PUTs carry it
 * too so an intermediary never caches a response that names a group.
 */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** 200 (or `status`) with a JSON body and `Cache-Control: no-store`. */
export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** `{ error }` with the given status. */
export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

/**
 * The request body as parsed JSON, or a marker that it could not be parsed.
 *
 * Distinguished from a parsed `null`/`undefined` by the wrapper: the validators decide what shapes
 * are acceptable, this only decides whether there was JSON at all.
 */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: (await req.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Map a thrown error from the settings module onto the status the contract assigns it.
 *
 * 400 for a body the caller can fix, 409 when the stored layer is not configured (the request is
 * well-formed but this deployment has nowhere to put it), 500 for anything else, with the message so
 * an operator reading the network tab sees the SDK's reason rather than "config write failed".
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ConsoleValidationError) return jsonError(400, err.message);
  if (err instanceof ConsoleNotConfiguredError) return jsonError(409, err.message);
  const detail = err instanceof Error ? err.message : String(err);
  return jsonError(500, `console settings failed: ${detail}`);
}

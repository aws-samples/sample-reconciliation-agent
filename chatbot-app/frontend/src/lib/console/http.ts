/**
 * Response helpers for the `/api/console/*` routes.
 *
 * The envelope itself is the shared `lib/server/http.ts`; what is console-specific here is that every
 * answer carries `Cache-Control: no-store` — a stored access group or an admin's preference change
 * must be visible on the next request, not after a browser or CDN cache TTL; the GETs are what the
 * contract requires it on, and the PUTs carry it too so an intermediary never caches a response that
 * names a group — and the mapping of this layer's own error classes onto statuses. Every failure body
 * is `{ error: string }`, the shape the shell already renders for the proxy's 401/403, so one
 * client-side reader covers all of them.
 */

import type { NextResponse } from "next/server";

import { jsonErrorNoStore } from "@/lib/server/http";
import { ConsoleNotConfiguredError } from "./settings";
import { ConsoleValidationError } from "./validation";

export { jsonNoStore, readJson } from "@/lib/server/http";
/** `{ error }` with the given status and `Cache-Control: no-store`. */
export { jsonErrorNoStore as jsonError } from "@/lib/server/http";

/**
 * Map a thrown error from the settings module onto the status the contract assigns it.
 *
 * 400 for a body the caller can fix, 409 when the stored layer is not configured (the request is
 * well-formed but this deployment has nowhere to put it), 500 for anything else, with the message so
 * an operator reading the network tab sees the SDK's reason rather than "config write failed".
 */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ConsoleValidationError) return jsonErrorNoStore(400, err.message);
  if (err instanceof ConsoleNotConfiguredError) return jsonErrorNoStore(409, err.message);
  const detail = err instanceof Error ? err.message : String(err);
  return jsonErrorNoStore(500, `console settings failed: ${detail}`);
}

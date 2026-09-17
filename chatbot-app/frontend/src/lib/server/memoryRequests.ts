/**
 * Request-side helpers for the AgentCore Memory routes, shared by `/api/recon/memory` and
 * `/api/pipeline/memory`.
 *
 * Neutral on purpose: nothing here reads an app's environment or names an app's memory, so either
 * app can import it without depending on the other. The parser THROWS a message naming the problem
 * rather than returning a sanitised body — a request asking to delete 60 records must be refused,
 * not quietly trimmed to 50, and a blank id must not silently become a no-op the caller reads as a
 * success.
 */

/**
 * Ceiling on one delete request.
 *
 * Each memory panel shows one bounded page, so a legitimate "select all and delete" never approaches
 * this; a request that does is a client bug or an attempt to wipe the memory in one call, and both
 * are better refused than serviced.
 */
export const MAX_DELETE_IDS = 50;

/**
 * Validate the id list a delete request carries.
 *
 * @param body the parsed JSON request body.
 * @returns the de-duplicated record ids to delete.
 * @throws Error when the body is not `{ ids: string[] }`, is empty, holds a blank or non-string id,
 *   or exceeds `MAX_DELETE_IDS` after de-duplication.
 */
export function parseMemoryDeleteIds(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) {
    throw new Error("body must be an object with an `ids` array");
  }
  if (ids.length === 0) {
    throw new Error("`ids` must name at least one memory record");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("every entry in `ids` must be a non-empty string");
    }
  }
  const unique = [...new Set((ids as string[]).map((id) => id.trim()))];
  if (unique.length > MAX_DELETE_IDS) {
    throw new Error(
      `at most ${MAX_DELETE_IDS} memory records may be deleted per request (got ${unique.length})`,
    );
  }
  return unique;
}

/**
 * Restrict a value to the character set AgentCore Memory accepts for actor and session ids.
 *
 * OIDC subjects and chat session ids can carry `|`, `@`, `:` or spaces; the memory API rejects them
 * with a validation error that names none of the offending characters, so replace them here. An
 * empty input becomes `"unknown"` rather than an empty id the API would also refuse.
 *
 * @param value the raw actor or session id.
 * @returns at most 100 characters of `[A-Za-z0-9_-]`, never empty.
 */
export function memorySafeId(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
  return safe || "unknown";
}

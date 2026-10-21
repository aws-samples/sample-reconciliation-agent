/**
 * The JSON core shared by the three BFF clients (`reconApi.ts`, `pipelineApi.ts`, `consoleApi.ts`).
 *
 * Each client binds these to its own label and authenticated transport; nothing here knows which app
 * is calling, so the console client can depend on it without depending on either app.
 */

/**
 * Unwrap a successful JSON response, or throw the server's own explanation.
 *
 * Every BFF answers a failure as `{ error: string }`; that message names the missing group, the unset
 * variable or the rejected field, which is what an operator needs to see. A non-JSON error body (a
 * proxy page, an empty 502), or one whose `error` is missing or not a string, falls back to
 * `<label> error <status>` so the message is never blank and never a stringified object.
 *
 * An empty 2xx body (a 204, or a route that answers with no content) resolves to `undefined` rather
 * than throwing on the parse — callers that do not need the body simply ignore it.
 *
 * @param resp the raw response from the client's authenticated fetch.
 * @param label the client's name for the fallback message, e.g. `"recon API"`.
 * @returns the parsed body, or `undefined` for an empty 2xx body.
 * @throws Error carrying `body.error` when the server gave one, else `<label> error <status>`.
 */
export async function parseJsonResponse<T>(
  resp: Response,
  label: string,
): Promise<T> {
  if (!resp.ok) {
    let detail = `${label} error ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: unknown } | null;
      if (typeof body?.error === "string" && body.error) detail = body.error;
    } catch {
      // Non-JSON error body: the status alone is the most honest message available.
    }
    throw new Error(detail);
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * A list route's body as an array.
 *
 * A list is the one shape two people write two ways: a bare array, or an envelope like
 * `{ emails: [...] }`. Accepting both keeps every page working whichever way a route settled, and the
 * envelope key is named per call so a wrong guess is an empty table rather than a crash.
 *
 * @param body the parsed response body.
 * @param key the envelope key to try when the body is not itself an array.
 * @returns the items, or an empty array when neither shape matches.
 */
export function listOf<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  const wrapped = (body as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}

/** Standard init for a JSON-bodied request. */
export function jsonInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/**
 * Typed client for the console-level BFF: `/api/console/*`, the layer above the two apps.
 *
 * Same shape as the two apps' clients (`reconApi.ts`, `pipelineApi.ts`) but importing neither: the
 * console must keep working when an app is removed. Every call attaches the ID token through the
 * shared `lib/auth/client-token` helper — the one reader all three clients present to the one
 * verifier — and a 401 starts the same re-authentication redirect the apps' wrappers start, because
 * under `/api/console/*` a 401 can only mean the token is missing or rejected.
 *
 * Failures throw `Error(body.error)` when the route explained itself and
 * `Error("console API error <status>")` when it did not, so the Settings screen shows the server's
 * own words ("group name too long", "console admins only") rather than a generic line.
 */

import { authHeaders } from "@/lib/auth/client-token";
import type {
  AccessCheckResult,
  ConsoleSettings,
  ConsoleSettingsUpdate,
  UserPreferences,
} from "@/lib/console/types";
import { reauthenticate } from "@/lib/reauth";
import { normalizePreferences } from "@/lib/shell/preferences";

/**
 * `fetch` for `/api/console/*` with the Authorization header attached.
 *
 * @param input same-origin console route.
 * @param init standard fetch init; headers given here are merged over the auth header.
 * @returns the raw `Response`; status handling stays with `json()`.
 */
export async function consoleFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const auth = await authHeaders();
  const response = await fetch(input, {
    ...init,
    headers: { ...auth, ...(init.headers as Record<string, string> | undefined) },
  });
  if (response.status === 401) {
    // Not awaited: the redirect resolves as the page unloads, and blocking here would keep the caller
    // from ever reporting the failure if the loop guard refuses the redirect.
    void reauthenticate("unauthorized").catch((error: unknown) =>
      console.error("[ConsoleApi] re-authentication failed:", error),
    );
  }
  return response;
}

/**
 * Unwrap a successful JSON body, or throw the server's own explanation.
 *
 * @throws Error carrying `body.error` when present, else `console API error <status>`.
 */
export async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    let detail = `console API error ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: unknown };
      if (typeof body?.error === "string" && body.error) detail = body.error;
    } catch {
      // Non-JSON error body (a load balancer page, an empty 502): the status is the honest message.
    }
    throw new Error(detail);
  }
  const text = await resp.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/** Every console-wide setting with its resolved value and source. Console admins only (403 otherwise). */
export async function getConsoleSettings(): Promise<ConsoleSettings> {
  return json(await consoleFetch("/api/console/settings", { cache: "no-store" }));
}

/**
 * Write the fields present in `update` ("" clears a stored value) and return the refreshed settings.
 *
 * The response, not the request, is what the screen shows afterwards: the chips must say where each
 * value NOW comes from, which only the server knows once the parameters are written.
 */
export async function updateConsoleSettings(update: ConsoleSettingsUpdate): Promise<ConsoleSettings> {
  return json(await consoleFetch("/api/console/settings", jsonInit("PUT", update)));
}

/**
 * What a hypothetical user holding exactly `groups` would be able to open and administer.
 *
 * @param groups verified-style group names; sent comma-separated, as the route documents.
 */
export async function accessCheck(groups: readonly string[]): Promise<AccessCheckResult> {
  const qs = encodeURIComponent(groups.join(","));
  return json(await consoleFetch(`/api/console/access-check?groups=${qs}`));
}

/** The caller's own preferences row. Any authenticated user. */
export async function getPreferences(): Promise<UserPreferences> {
  return normalizePreferences(await json(await consoleFetch("/api/console/preferences", { cache: "no-store" })));
}

/**
 * Replace the caller's preferences row.
 *
 * Callers send the WHOLE object (current preferences with the change applied), never a patch: the row
 * is one JSON parameter, and sending it complete means a field the user cleared is absent from the
 * body rather than depending on how the route merges.
 */
export async function putPreferences(prefs: UserPreferences): Promise<UserPreferences> {
  const body = await json<unknown>(await consoleFetch("/api/console/preferences", jsonInit("PUT", prefs)));
  // A route that answers 204 has, by its own account, stored what it was sent.
  return body === undefined ? normalizePreferences(prefs) : normalizePreferences(body);
}

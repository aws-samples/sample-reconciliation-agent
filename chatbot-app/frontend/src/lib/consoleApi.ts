/**
 * Typed client for the console-level BFF: `/api/console/*`, the layer above the two apps.
 *
 * Same shape as the two apps' clients (`reconApi.ts`, `pipelineApi.ts`) but importing neither: the
 * console must keep working when an app is removed. Every call goes through the shared
 * `lib/auth/authed-fetch` wrapper — the one reader all three clients present to the one verifier —
 * which attaches the ID token and, on a 401, starts the same re-authentication redirect the apps'
 * clients start, because under `/api/console/*` a 401 can only mean the token is missing or rejected.
 *
 * Failures throw `Error(body.error)` when the route explained itself and
 * `Error("console API error <status>")` when it did not, so the Settings screen shows the server's
 * own words ("group name too long", "console admins only") rather than a generic line.
 */

import { jsonInit, parseJsonResponse } from "@/lib/api/client";
import { authedFetch } from "@/lib/auth/authed-fetch";
import type {
  AccessCheckResult,
  ConsoleSettings,
  ConsoleSettingsUpdate,
  UserPreferences,
} from "@/lib/console/types";
import { normalizePreferences } from "@/lib/shell/preferences";

/**
 * `fetch` for `/api/console/*` with the Authorization header attached.
 *
 * @param input same-origin console route.
 * @param init standard fetch init; headers given here are merged over the auth header.
 * @returns the raw `Response`; status handling stays with `json()`.
 */
export const consoleFetch = (input: string, init: RequestInit = {}): Promise<Response> =>
  authedFetch(input, init, "ConsoleApi");

/** The shared JSON reader (`lib/api/client.ts`) under the console label. */
const json = <T>(resp: Response): Promise<T> => parseJsonResponse<T>(resp, "console API");

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

/**
 * Browser-side `fetch` for any BFF call: the ID token attached, a 401 turned into a re-authentication.
 *
 * The one wrapper behind the recon client (`recon-auth.ts`), the pipeline client (`pipeline-auth.ts`)
 * and the console client (`consoleApi.ts`). Each of those carried its own copy of these twenty lines;
 * the copies were identical apart from the prefix on the log line, which is what `label` is for. The
 * token itself comes from `client-token.ts` (one OIDC client, one reader) and the redirect from
 * `reauth.ts` (one way back to the provider), so this module adds nothing but the header merge and the
 * 401 backstop.
 *
 * A 401 starts a re-authentication redirect. Under every BFF prefix a 401 can only mean the token was
 * missing, malformed or rejected — an authorization failure is the gate's 403, and the gate reports
 * its own problems as 503 — so "sign in again" is the correct response rather than a guess. This is
 * the backstop for the cases the auth wrapper's `expired` listener cannot see: the SDK only runs its
 * expiry service in the leader tab, and a token the server rejects for any other reason never fires a
 * client-side event.
 */

import { authHeaders } from "@/lib/auth/client-token";
import { reauthenticate } from "@/lib/reauth";

/**
 * `fetch` with the Authorization header attached.
 *
 * @param input request URL (same-origin `/api/...`).
 * @param init standard fetch init; any headers given here are preserved and merged over the auth header.
 * @param label prefix for the log line should the redirect itself fail, e.g. "ReconAuth".
 * @returns the raw `Response` — status handling stays with the caller, including on a 401.
 */
export async function authedFetch(
  input: string,
  init: RequestInit = {},
  label = "AuthedFetch",
): Promise<Response> {
  const auth = await authHeaders();
  const response = await fetch(input, {
    ...init,
    headers: {
      ...auth,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

  if (response.status === 401) {
    // Deliberately not awaited. The redirect resolves as the page unloads, and blocking on it
    // would stop the caller from ever handling the 401 — leaving a blank panel behind if the
    // navigation is refused or slow. Start it, hand the response back, let both proceed.
    void reauthenticate("unauthorized").catch((error: unknown) =>
      console.error(`[${label}] re-authentication failed:`, error),
    );
  }
  return response;
}

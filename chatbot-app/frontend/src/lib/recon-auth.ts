/**
 * Browser-side `fetch` for calls to the reconciliation BFF.
 *
 * The ID token itself comes from `lib/auth/client-token.ts`, which the shell and the pipeline client
 * share: one OIDC client, one token reader. This module adds only what is specific to the recon BFF,
 * the `/api/recon/*` wrapper that attaches the header and turns a 401 into a re-authentication.
 * `authHeaders` and `reconIdToken` are re-exported under the names existing call sites and tests use.
 */

import { authHeaders } from "@/lib/auth/client-token";
import { reauthenticate } from "@/lib/reauth";

export { authHeaders, idToken as reconIdToken } from "@/lib/auth/client-token";

/**
 * `fetch` for the recon BFF, with the Authorization header attached.
 *
 * Every `/api/recon/*` call goes through this ONE wrapper (see reconApi.ts) precisely so that no
 * future call site can forget the header and reintroduce P0-2 from the client side.
 *
 * A 401 starts a re-authentication redirect. Under `/api/recon/*` a 401 can only mean the token
 * was missing, malformed or rejected — `authorizeRequest` has no authorization tier that could
 * reject an authenticated caller (that is the proxy's 403), and it reports its own problems as 503 —
 * so "sign in again" is the correct response rather than a guess. This is the backstop for the cases
 * the auth wrapper's `expired` listener cannot see: the SDK only runs its expiry service in the
 * leader tab, and a token the server rejects for any other reason never fires a client-side event.
 *
 * @param input request URL (same-origin `/api/recon/...`).
 * @param init standard fetch init; any headers given here are preserved and merged.
 * @returns the raw `Response` — status handling stays with the caller, including on a 401.
 */
export async function reconFetch(
  input: string,
  init: RequestInit = {},
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
      console.error("[ReconAuth] re-authentication failed:", error),
    );
  }
  return response;
}

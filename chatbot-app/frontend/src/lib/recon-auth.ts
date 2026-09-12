/**
 * Browser-side `fetch` for calls to the reconciliation BFF.
 *
 * The ID token itself comes from `lib/auth/client-token.ts`, which the shell and the pipeline client
 * share: one OIDC client, one token reader. The wrapper that attaches the header and turns a 401 into
 * a re-authentication is `lib/auth/authed-fetch.ts`, shared the same way; this module binds it to the
 * recon log label and re-exports `authHeaders` and `reconIdToken` under the names existing call sites
 * and tests use.
 */

import { authedFetch } from "@/lib/auth/authed-fetch";

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
 * so "sign in again" is the correct response rather than a guess. See `authedFetch` for the rest.
 *
 * @param input request URL (same-origin `/api/recon/...`).
 * @param init standard fetch init; any headers given here are preserved and merged.
 * @returns the raw `Response` — status handling stays with the caller, including on a 401.
 */
export const reconFetch = (
  input: string,
  init: RequestInit = {},
): Promise<Response> => authedFetch(input, init, "ReconAuth");

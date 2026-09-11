/**
 * Browser-side Authorization header for calls to the deal-pipeline BFF.
 *
 * Counterpart to `src/lib/api-auth.ts` (the server verifier) and `src/proxy.ts` (the gate).
 * The BFF verifies the OIDC **ID token**, so that is what we attach — see api-auth.ts for why an
 * ID token rather than an access token, and what would replace it.
 *
 * Both providers' clients are reached through the instance the auth wrapper stashes on `window`
 * (`__okta_instance` / `__msal_instance`); when the wrapper has not built one yet, one is
 * constructed from the same config rather than kept as a second parallel client.
 *
 * Returns no header when unauthenticated (local dev, where no provider is configured). That is not a
 * silent failure: the server decides, and it only accepts a missing header when
 * `ALLOW_ANONYMOUS_API=true` (or the older `PIPELINE_ALLOW_ANONYMOUS_API=true`) is explicitly set.
 */

import { reauthenticate } from "@/lib/reauth";

const PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra";

/** Read the current Okta ID token from the wrapper's OktaAuth instance. */
async function oktaIdToken(): Promise<string | null> {
  const {
    HAS_OKTA_CONFIG,
    oktaConfig,
    oktaRedirectUri,
    oktaTokenManagerOptions,
  } = await import("@/lib/okta-config");
  if (!HAS_OKTA_CONFIG) return null;

  const { OktaAuth } = await import("@okta/okta-auth-js");
  const w = window as unknown as {
    __okta_instance?: InstanceType<typeof OktaAuth>;
  };
  const instance =
    w.__okta_instance ??
    new OktaAuth({
      issuer: oktaConfig.issuer,
      clientId: oktaConfig.clientId,
      redirectUri: oktaRedirectUri(),
      scopes: [...oktaConfig.scopes],
      pkce: oktaConfig.pkce,
      // Whichever construction site runs first defines the instance everything else shares, so
      // silent renew must be switched off here too — not only in the auth wrapper.
      tokenManager: { ...oktaTokenManagerOptions },
    });
  w.__okta_instance = instance;

  // tokenManager holds what handleLoginRedirect stored; it does not hit the network.
  const { idToken } = await instance.tokenManager.getTokens();
  return idToken?.idToken ?? null;
}

/** Read the current Entra ID token from the MSAL account the wrapper signed in. */
async function entraIdToken(): Promise<string | null> {
  const [{ PublicClientApplication }, { msalConfig, HAS_ENTRA_CONFIG }] =
    await Promise.all([
      import("@azure/msal-browser"),
      import("@/lib/msal-config"),
    ]);
  if (!HAS_ENTRA_CONFIG) return null;

  const w = window as unknown as {
    __msal_instance?: InstanceType<typeof PublicClientApplication>;
  };
  const instance = w.__msal_instance ?? new PublicClientApplication(msalConfig);
  w.__msal_instance = instance;

  const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
  if (!account) return null;
  // Silent acquisition refreshes the ID token alongside the access token when it has expired.
  // `openid` alone is enough — we are not asking for an API scope here.
  const result = await instance.acquireTokenSilent({
    scopes: ["openid"],
    account,
  });
  return result.idToken ?? null;
}

/**
 * The ID token for the signed-in user, or null when there is no session.
 *
 * Never throws: a token-read failure must surface as a 401 from the BFF (with the server's
 * reason) rather than as an unhandled rejection inside an unrelated data fetch.
 */
export async function pipelineIdToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    return PROVIDER === "okta" ? await oktaIdToken() : await entraIdToken();
  } catch (error) {
    console.warn("[PipelineAuth] could not read ID token:", error);
    return null;
  }
}

/**
 * Authorization header for the pipeline BFF, or `{}` when unauthenticated.
 *
 * Returns a spreadable object so callers never branch on the signed-in state.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await pipelineIdToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetch` for the pipeline BFF, with the Authorization header attached.
 *
 * Every `/api/pipeline/*` call goes through this ONE wrapper (see pipelineApi.ts) precisely so
 * that no future call site can forget the header and send an unauthenticated request from the
 * client side.
 *
 * A 401 starts a re-authentication redirect. Under `/api/pipeline/*` a 401 can only mean the
 * token was missing, malformed or rejected — the gate has no authorization tier that could
 * reject an authenticated caller, and it reports its own problems as 503 — so "sign in again" is
 * the correct response rather than a guess. This is the backstop for the cases the auth wrapper's
 * `expired` listener cannot see: the SDK only runs its expiry service in the leader tab, and a
 * token the server rejects for any other reason never fires a client-side event at all.
 *
 * @param input request URL (same-origin `/api/pipeline/...`).
 * @param init standard fetch init; any headers given here are preserved and merged.
 * @returns the raw `Response` — status handling stays with the caller, including on a 401.
 */
export async function pipelineFetch(
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
      console.error("[PipelineAuth] re-authentication failed:", error),
    );
  }
  return response;
}

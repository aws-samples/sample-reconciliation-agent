/**
 * Browser-side OIDC ID token for the console shell and both apps' BFF clients.
 *
 * Counterpart to `src/lib/api-auth.ts` (the server verifier) and `src/proxy.ts` (the gate). The BFF
 * verifies the OIDC **ID token**, so that is what callers attach — see api-auth.ts for why an ID
 * token rather than an access token, and what would replace it.
 *
 * One copy, under `lib/auth/`, because there is one OIDC client: the shell (`/api/me`), the recon
 * client (`recon-auth.ts`) and the pipeline client (`pipelineApi.ts`) all present the same token to
 * the same verifier, through the one `fetch` wrapper in `authed-fetch.ts` (401 handling). The shell
 * imports this module directly, so removing an app cannot take the shell's token reader with it, and
 * a token-read failure is logged under a neutral prefix instead of being blamed on whichever app
 * happened to own the copy.
 *
 * The SDK-backed providers' clients are reached through the instance the auth wrapper stashes on
 * `window` (`__okta_instance` / `__msal_instance`); when the wrapper has not built one yet, one is
 * constructed from the same config rather than kept as a second parallel client. The Cognito path has
 * no SDK and no instance: its tokens live in this tab's `sessionStorage` and
 * `lib/auth/cognito-pkce.ts` refreshes them on read, so a token that has aged out is renewed here
 * rather than at some later 401.
 *
 * Returns no header when unauthenticated (local dev, or unconfigured builds). That is not a silent
 * failure: the server decides, and it only accepts a missing header when `ALLOW_ANONYMOUS_API=true`
 * (or one of the older app-specific switches) is explicitly set.
 */

import { authProviderBranch } from "@/lib/auth/provider";

/**
 * Read the current Cognito ID token, refreshing it first if it has expired or is about to.
 *
 * Dynamically imported like the other two branches, so a build using a different provider does not
 * carry this module — and so a test can mock it.
 */
async function cognitoIdToken(): Promise<string | null> {
  const { HAS_COGNITO_CONFIG, currentIdToken } = await import(
    "@/lib/auth/cognito-pkce"
  );
  if (!HAS_COGNITO_CONFIG) return null;
  return currentIdToken();
}

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
export async function idToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    switch (authProviderBranch()) {
      case "okta":
        return await oktaIdToken();
      case "entra":
        return await entraIdToken();
      default:
        return await cognitoIdToken();
    }
  } catch (error) {
    console.warn("[ClientToken] could not read ID token:", error);
    return null;
  }
}

/**
 * Authorization header for any BFF call, or `{}` when unauthenticated.
 *
 * Returns a spreadable object so callers never branch on the signed-in state.
 */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await idToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

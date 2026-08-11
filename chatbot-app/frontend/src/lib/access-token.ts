/**
 * Browser-side access token retrieval for Microsoft Entra ID.
 *
 * This is the single async helper for non-React callers (api-client, hooks,
 * components that need to attach Authorization headers). It reuses the
 * MSAL instance EntraAuthWrapper stashes on window so we don't construct
 * a parallel client.
 *
 * Returns null when:
 *   - Entra config is missing (local dev / unconfigured deploys)
 *   - No account is signed in
 *   - Silent token acquisition failed and an interactive redirect was kicked
 *     off (the page is about to reload)
 */

/**
 * In-flight token acquisition shared across concurrent callers.
 *
 * Page load fires `triggerWarmup` and the first `sendMessage` (and any other
 * authed fetch) at nearly the same time. Each calls `getAccessToken`. When the
 * cached token is expired, every caller hits `InteractionRequiredAuthError` and
 * races to call `acquireTokenRedirect` — the second caller throws MSAL's
 * `interaction_in_progress`, which the catch below swallows, returning an
 * unauthenticated `null` and producing the AgentCore 401
 * (`-32001 Missing Authentication Token`). Sharing one promise means concurrent
 * callers await the same acquisition (and the same single redirect) instead of
 * each kicking off their own.
 */
let inFlightAcquisition: Promise<string | null> | null = null;

async function acquireAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  try {
    const [
      { PublicClientApplication, InteractionRequiredAuthError },
      { msalConfig, tokenRequest, HAS_ENTRA_CONFIG },
    ] = await Promise.all([
      import("@azure/msal-browser"),
      import("@/lib/msal-config"),
    ]);
    if (!HAS_ENTRA_CONFIG) return null;

    const w = window as unknown as {
      __msal_instance?: InstanceType<typeof PublicClientApplication>;
    };
    const instance =
      w.__msal_instance ?? new PublicClientApplication(msalConfig);
    w.__msal_instance = instance;

    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
    if (!account) return null;

    try {
      const result = await instance.acquireTokenSilent({
        ...tokenRequest,
        account,
      });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        // Session expired — redirect to Microsoft to re-authenticate. The page
        // navigates away, so callers should treat the null below as "auth in
        // progress" rather than a transient failure.
        await instance.acquireTokenRedirect(tokenRequest);
        return null;
      }
      throw err;
    }
  } catch (error) {
    console.log("[Auth] Token acquisition failed:", error);
    return null;
  }
}

export async function getAccessToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  // Coalesce concurrent callers onto a single acquisition so we never trigger
  // two interactive redirects (which collide with `interaction_in_progress`).
  if (!inFlightAcquisition) {
    inFlightAcquisition = acquireAccessToken().finally(() => {
      inFlightAcquisition = null;
    });
  }
  return inFlightAcquisition;
}

/**
 * Convenience wrapper returning the headers map directly. Returns an empty
 * object when no token is available so callers can spread it unconditionally.
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Return the current user's stable identifier. Reads `oid` (object ID) from
 * the MSAL account. Returns 'anonymous' when no account is signed in.
 *
 * Use this instead of decoding access tokens in callers — MSAL exposes the
 * claims via the account record without needing the token.
 */
export async function getCurrentUserId(): Promise<string> {
  if (typeof window === "undefined") return "anonymous";
  try {
    const [{ PublicClientApplication }, { msalConfig, HAS_ENTRA_CONFIG }] =
      await Promise.all([
        import("@azure/msal-browser"),
        import("@/lib/msal-config"),
      ]);
    if (!HAS_ENTRA_CONFIG) return "anonymous";

    const w = window as unknown as {
      __msal_instance?: InstanceType<typeof PublicClientApplication>;
    };
    const instance =
      w.__msal_instance ?? new PublicClientApplication(msalConfig);
    w.__msal_instance = instance;

    const account = instance.getActiveAccount() ?? instance.getAllAccounts()[0];
    if (!account) return "anonymous";

    // MSAL puts the oid in account.idTokenClaims (when an ID token has been
    // issued — true after sign-in for the SPA flow).
    const claims = (account.idTokenClaims ?? {}) as Record<string, unknown>;
    const oid = claims.oid as string | undefined;
    return (
      oid ?? account.localAccountId ?? account.homeAccountId ?? "anonymous"
    );
  } catch {
    return "anonymous";
  }
}

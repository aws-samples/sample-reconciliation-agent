/**
 * Recovery from an expired session: a top-level redirect back to the identity provider.
 *
 * This is the ONE way the app re-authenticates, shared by everything that can discover the
 * session is gone — the auth wrapper's `expired` listener, its "Sign in again" button, and the
 * 401 backstop in `reconFetch`.
 *
 * This is the FALLBACK, not the first response to an expiring session: `okta-renew.ts` renews
 * silently with the refresh token, and this module is where the app lands when that is impossible
 * or was refused.
 *
 * Why a top-level redirect and not the SDK's own silent renew:
 *
 * `@okta/okta-auth-js` has two renewal mechanisms and picks between them by whether a refresh token
 * is in storage. The refresh-token one is a POST to /token, and that is the one `okta-renew.ts`
 * uses. The other loads the provider's /authorize endpoint in a hidden iframe (`prompt=none`), and
 * that one never worked here and never can:
 *
 *  1. The CloudFront CSP is `default-src 'self'` with no `frame-src`, so the browser refuses to
 *     load the frame. No postMessage ever arrives and the SDK waits out its full 120 s timeout —
 *     which is what produced the permanent "Signing in with Okta..." screen.
 *  2. Even with a `frame-src` allowance, the iframe reads the provider's session cookie in a
 *     third-party context. Safari's ITP already blocks that and Chrome is phasing it out, so the
 *     mechanism would rot rather than fail once, visibly.
 *
 * A top-level navigation has none of that: the provider's session cookie is first-party, so a
 * live session round-trips with no user interaction and a dead one lands on the login page, which
 * is the correct outcome. The cost is a full page load, and `originalUri` puts the user back on
 * the page they were on.
 *
 * `autoRenew` stays off in the SDK so the iframe path is unreachable — see
 * `oktaTokenManagerOptions` for why that is what enforces it.
 */

const PROVIDER = process.env.NEXT_PUBLIC_AUTH_PROVIDER ?? "entra";

/** What discovered that the session is gone. `"user"` bypasses the loop guard below. */
export type ReauthTrigger = "user" | "expired" | "unauthorized";

/** sessionStorage key holding when the last automatic re-auth started (epoch ms, as a string). */
const LAST_REAUTH_KEY = "recon.auth.lastAutomaticReauthAt";

/**
 * Shortest gap between two AUTOMATIC re-auth redirects.
 *
 * The guard is not about expiry, which happens on the order of an hour. It is about a 401 that
 * re-authenticating cannot fix — a server whose `OKTA_CLIENT_ID` no longer matches the client's,
 * say, rejects every freshly-minted token too. Without a floor, each rejection would start
 * another redirect and the browser would loop between the app and the provider forever. With it,
 * the second failure inside a minute stops and the caller's own error surfaces, which is what
 * tells an operator the configuration is broken rather than the session.
 */
const MIN_AUTOMATIC_REAUTH_INTERVAL_MS = 60_000;

/**
 * Why an automatic re-auth must not start right now.
 *
 * @returns the reason to log, or null when starting one is fine.
 */
function automaticReauthRefusal(): string | null {
  const raw = window.sessionStorage.getItem(LAST_REAUTH_KEY);
  if (!raw) return null;
  const last = Number(raw);
  // A non-numeric value means something else wrote the key. Refuse rather than parse it into NaN
  // and compare, which is always false and would read as "allowed" — the opposite of safe.
  if (!Number.isFinite(last)) {
    return `the guard mark in sessionStorage ("${LAST_REAUTH_KEY}") is not a timestamp: "${raw}"`;
  }
  const elapsedMs = Date.now() - last;
  if (elapsedMs < MIN_AUTOMATIC_REAUTH_INTERVAL_MS) {
    return (
      `another automatic attempt was made ${Math.round(elapsedMs / 1000)}s ago, and the ` +
      `minimum gap is ${MIN_AUTOMATIC_REAUTH_INTERVAL_MS / 1000}s`
    );
  }
  return null;
}

/**
 * Start an Okta sign-in redirect, returning the user to the current URL afterwards.
 *
 * @param originalUri absolute URL to return to once sign-in completes.
 */
async function oktaReauth(originalUri: string): Promise<boolean> {
  const {
    HAS_OKTA_CONFIG,
    oktaConfig,
    oktaRedirectUri,
    oktaTokenManagerOptions,
  } = await import("@/lib/okta-config");
  if (!HAS_OKTA_CONFIG) return false;

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
      tokenManager: { ...oktaTokenManagerOptions },
    });
  w.__okta_instance = instance;

  // Drop the dead tokens before leaving. If the redirect itself fails (a post-logout URI the
  // provider rejects, a network drop mid-navigation) the app must come back unauthenticated and
  // say so, not holding a token that makes every API call 401 while the UI looks signed in.
  instance.tokenManager.clear();
  // `originalUri` is stored by the SDK and consumed by handleLoginRedirect(), which navigates
  // there itself — see the callback route, whose redirect to "/" is only the no-originalUri case.
  await instance.signInWithRedirect({ originalUri });
  return true;
}

/**
 * Start an Entra sign-in redirect, returning the user to the current URL afterwards.
 *
 * @param originalUri absolute URL to return to once sign-in completes.
 */
async function entraReauth(originalUri: string): Promise<boolean> {
  const [
    { PublicClientApplication },
    { msalConfig, HAS_ENTRA_CONFIG, tokenRequest },
  ] = await Promise.all([
    import("@azure/msal-browser"),
    import("@/lib/msal-config"),
  ]);
  if (!HAS_ENTRA_CONFIG) return false;

  const w = window as unknown as {
    __msal_instance?: InstanceType<typeof PublicClientApplication>;
  };
  const instance = w.__msal_instance ?? new PublicClientApplication(msalConfig);
  w.__msal_instance = instance;

  // MSAL's equivalent of Okta's originalUri.
  await instance.loginRedirect({
    ...tokenRequest,
    redirectStartPage: originalUri,
  });
  return true;
}

/**
 * Re-authenticate the current user by redirecting to the identity provider.
 *
 * @param trigger what discovered the session was gone. Anything other than `"user"` is subject to
 *   the once-a-minute loop guard.
 * @returns true when a redirect was started (the page is now navigating away); false when there
 *   is no provider to redirect to, or the loop guard refused. A false return is the caller's cue
 *   to show an error — never to keep waiting, which is the bug this module exists to kill.
 * @throws whatever the provider SDK throws while starting the redirect.
 */
export async function reauthenticate(trigger: ReauthTrigger): Promise<boolean> {
  if (typeof window === "undefined") return false;

  if (trigger !== "user") {
    const refusal = automaticReauthRefusal();
    if (refusal) {
      console.warn(
        `[Reauth] not re-authenticating (${trigger}): ${refusal}. Signing in again does not ` +
          `appear to fix this, so the underlying error is being surfaced instead.`,
      );
      return false;
    }
    window.sessionStorage.setItem(LAST_REAUTH_KEY, String(Date.now()));
  }

  const originalUri = window.location.href;
  const started =
    PROVIDER === "okta"
      ? await oktaReauth(originalUri)
      : await entraReauth(originalUri);

  if (!started) {
    // No configured provider: this build runs unauthenticated (local dev, or a deploy whose
    // NEXT_PUBLIC_* vars were not baked in). A 401 here is a server-side configuration problem —
    // the BFF wants a token nobody can mint — so name that rather than looking broken silently.
    console.error(
      `[Reauth] cannot re-authenticate (${trigger}): NEXT_PUBLIC_AUTH_PROVIDER is ` +
        `"${PROVIDER}" but its issuer/client id are not configured in this build. If the API is ` +
        `rejecting calls, the server needs ALLOW_ANONYMOUS_API=true or a real provider.`,
    );
  }
  return started;
}

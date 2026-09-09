/**
 * Silent token renewal for the Okta path, done with the REFRESH TOKEN and nothing else.
 *
 * The SDK can renew two ways and only one of them is usable here:
 *
 *  - a POST to the provider's /token endpoint carrying a refresh token. The CloudFront CSP already
 *    allows it (`connect-src 'self' https://*.okta.com`), it needs no third-party cookie, and it is
 *    invisible to the user. This module does this one.
 *  - loading /authorize in a hidden iframe with `prompt=none`. The CSP is `default-src 'self'` with
 *    no `frame-src`, so the frame never loads, no postMessage arrives, and the SDK waits out its
 *    full 120 s timeout — which is exactly the permanent "Signing in with Okta..." screen that was
 *    reported. `reauth.ts` explains why the answer is a top-level redirect rather than opening
 *    `frame-src` up.
 *
 * `@okta/okta-auth-js` picks between them by whether a refresh token happens to be in storage
 * (`oidc/renewTokens.js`), so the guard below is not a courtesy: checking FIRST is what makes the
 * iframe unreachable. Whether a refresh token exists is not something this build can know —
 * `offline_access` has to be requested (it is, see `okta-config.ts`), the Okta app has to permit the
 * Refresh Token grant, AND the custom authorization server's access-policy rule has to grant the
 * scope. Any one of those missing produces a token response with no `refresh_token` and no error, so
 * "there is no refresh token" is a routine state to be handled, not an exception.
 */
import type { OktaAuth } from "@okta/okta-auth-js";

/**
 * How long before expiry to renew.
 *
 * Two minutes rather than a few seconds because the point is that no request ever meets an expired
 * token: a renew that lands after expiry still works, but every call in flight meanwhile gets a 401,
 * and `reconFetch`'s 401 backstop reacts to those by starting a sign-in redirect — the very
 * interruption this module exists to avoid. Comfortably inside Okta's one-hour default access-token
 * lifetime.
 */
const RENEW_LEAD_SECONDS = 120;

/**
 * Floor on the scheduled delay.
 *
 * A token already inside the lead window (or past expiry) yields a negative delay, and firing on a
 * zero timer would renew synchronously with the mount. The second of slack keeps that off the
 * critical path of the first render.
 */
const MIN_RENEW_DELAY_MS = 1_000;

/** What a renewal attempt did. */
export type RenewOutcome = "renewed" | "no-refresh-token" | "failed";

/**
 * Is there a refresh token in storage to renew with?
 *
 * @param oktaAuth the app's OktaAuth instance.
 * @returns true when the token manager holds a refresh token.
 */
export function hasRefreshToken(oktaAuth: OktaAuth): boolean {
  return !!oktaAuth.tokenManager.getTokensSync().refreshToken;
}

/**
 * Renew the access and ID tokens now, using the refresh token.
 *
 * @param oktaAuth the app's OktaAuth instance.
 * @returns `"renewed"` when fresh tokens are in storage; `"no-refresh-token"` when there was
 *   nothing to renew with (an Okta configuration state — see the module comment — and the caller's
 *   cue to fall back to a top-level redirect); `"failed"` when the provider refused.
 */
export async function renewWithRefreshToken(
  oktaAuth: OktaAuth,
): Promise<RenewOutcome> {
  if (!hasRefreshToken(oktaAuth)) {
    console.warn(
      "[Okta] no refresh token, so this session cannot be renewed silently. Check that " +
        "`offline_access` is requested, that the Okta app permits the Refresh Token grant, and " +
        "that the authorization server's access-policy rule grants `offline_access`.",
    );
    return "no-refresh-token";
  }
  try {
    // Safe to call now the guard above has run: with a refresh token present the SDK POSTs to
    // /token and never reaches the blocked iframe.
    const tokens = await oktaAuth.token.renewTokens();
    // renewTokens() returns the tokens; it does not store them. Skipping this leaves the app
    // holding the ones that were about to expire while believing it renewed.
    oktaAuth.tokenManager.setTokens(tokens);
    return "renewed";
  } catch (err: unknown) {
    console.error("[Okta] refresh-token renewal failed:", err);
    return "failed";
  }
}

/**
 * When the next renewal should happen.
 *
 * @param oktaAuth the app's OktaAuth instance.
 * @returns the expiry being scheduled against (epoch seconds) and how long from now to fire, or
 *   null when there is no token to schedule against at all.
 */
function nextRenew(
  oktaAuth: OktaAuth,
): { earliestSeconds: number; delayMs: number } | null {
  const { accessToken, idToken } = oktaAuth.tokenManager.getTokensSync();
  // `expiresAt` is epoch SECONDS in this SDK, not milliseconds.
  const expiries = [accessToken?.expiresAt, idToken?.expiresAt].filter(
    (value): value is number => typeof value === "number",
  );
  if (expiries.length === 0) return null;
  // The earliest one: renewing on the later token's schedule would let the earlier one lapse first,
  // and the BFF verifies the ID token.
  const earliestSeconds = Math.min(...expiries);
  const delayMs = (earliestSeconds - RENEW_LEAD_SECONDS) * 1000 - Date.now();
  return { earliestSeconds, delayMs: Math.max(delayMs, MIN_RENEW_DELAY_MS) };
}

/**
 * Keep the session alive in the background for as long as the caller is mounted.
 *
 * Renews shortly BEFORE expiry rather than in response to it. The SDK's own AutoRenewService is
 * reactive — it renews on the token manager's `expired` event — which means the token is already
 * dead by the time it acts and anything in flight has 401'd.
 *
 * @param oktaAuth the app's OktaAuth instance.
 * @param onUnrecoverable called with a human-readable reason when the session can no longer be
 *   renewed silently. The caller's job then is to re-authenticate at the top level; renewal stops.
 * @returns a function that cancels the pending renewal. Call it on unmount.
 */
export function startSilentRenew({
  oktaAuth,
  onUnrecoverable,
}: {
  oktaAuth: OktaAuth;
  onUnrecoverable: (reason: string) => void;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set by the returned canceller. Checked after every await so a renewal that resolves post-unmount
  // cannot schedule another timer or call back into an unmounted component.
  let stopped = false;

  /**
   * Arm the next renewal.
   *
   * @param renewedFromSeconds the expiry the previous renewal was supposed to move past, or null on
   *   the first call. Used to refuse a renewal that reports success without buying any time.
   */
  const schedule = (renewedFromSeconds: number | null): void => {
    if (stopped) return;
    const next = nextRenew(oktaAuth);
    if (next === null) {
      onUnrecoverable("there are no tokens to renew");
      return;
    }
    if (
      renewedFromSeconds !== null &&
      next.earliestSeconds <= renewedFromSeconds
    ) {
      // A renewal that reported success but left the expiry where it was. Rescheduling would land
      // back inside the lead window, clamp to the delay floor, and renew once a second for as long
      // as the tab stayed open — so stop and say so instead.
      onUnrecoverable("renewing the session did not extend it");
      return;
    }
    timer = setTimeout(() => {
      void (async () => {
        const outcome = await renewWithRefreshToken(oktaAuth);
        if (stopped) return;
        if (outcome === "renewed") {
          // Re-read the new expiry rather than assuming the previous interval: token lifetimes are
          // set by Okta policy and can change under a running app.
          schedule(next.earliestSeconds);
          return;
        }
        onUnrecoverable(
          outcome === "no-refresh-token"
            ? "this session has no refresh token, so it cannot be renewed without signing in again"
            : "renewing the session was refused",
        );
      })();
    }, next.delayMs);
  };

  schedule(null);

  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

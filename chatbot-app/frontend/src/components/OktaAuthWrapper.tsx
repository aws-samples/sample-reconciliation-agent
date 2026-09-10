"use client";

import { useEffect, useState } from "react";
import { OktaAuth } from "@okta/okta-auth-js";
import {
  HAS_OKTA_CONFIG,
  OKTA_REDIRECT_URI_IS_PINNED,
  oktaConfig,
  oktaRedirectUri,
  oktaTokenManagerOptions,
} from "@/lib/okta-config";
import { renewWithRefreshToken, startSilentRenew } from "@/lib/okta-renew";
import { reauthenticate } from "@/lib/reauth";

/**
 * Okta OIDC auth gate (mirrors EntraAuthWrapper). Active when
 * NEXT_PUBLIC_AUTH_PROVIDER === 'okta'. Handles the redirect callback, kicks off interactive
 * login when there's no session, stashes the OktaAuth instance on window for UserMenu/signOut,
 * and renders children once authenticated. Runs children directly in local dev / when unconfigured.
 */

/**
 * How long the sign-in handshake may take before the UI stops waiting and explains itself.
 *
 * Generous: with silent renew off, the only network call on this path is the code-for-token
 * exchange on the callback. The number exists to bound the wait, not to race a slow network.
 */
const AUTH_HANDSHAKE_TIMEOUT_MS = 20_000;

function getOktaInstance(): OktaAuth {
  const w = window as unknown as { __okta_instance?: OktaAuth };
  if (!w.__okta_instance) {
    w.__okta_instance = new OktaAuth({
      issuer: oktaConfig.issuer,
      clientId: oktaConfig.clientId,
      redirectUri: oktaRedirectUri(),
      scopes: [...oktaConfig.scopes],
      pkce: oktaConfig.pkce,
      tokenManager: { ...oktaTokenManagerOptions },
    });
  }
  return w.__okta_instance;
}

/**
 * The redirect URI as a human-readable string for the error state.
 *
 * Separate from `oktaRedirectUri()` because that throws on a malformed pinned value, and the
 * error screen must be able to render the bad value rather than blow up while explaining it.
 *
 * @returns the callback URL, or a description of why there isn't one.
 */
function describeRedirectUri(): string {
  try {
    return oktaRedirectUri() || "(unknown)";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function oktaSignOut(): Promise<void> {
  const oktaAuth = getOktaInstance();
  // Don't revoke tokens before the logout redirect: if the redirect then fails (e.g. a
  // misconfigured post-logout URI), the browser is left holding revoked-but-unexpired tokens
  // and the app wedges in a "signed in but every API call 401s" limbo. Clearing local tokens
  // is sufficient for an SPA logout; the Okta session ends via the /logout redirect.
  await oktaAuth.signOut({
    postLogoutRedirectUri:
      typeof window !== "undefined" ? window.location.origin : undefined,
    revokeAccessToken: false,
    revokeRefreshToken: false,
    clearTokensBeforeRedirect: true,
  });
}

/** Current signed-in Okta user's display name/email, or null. */
export async function oktaUserName(): Promise<string | null> {
  const oktaAuth = getOktaInstance();
  // Read identity from the local ID token claims instead of calling /userinfo: the ID token
  // (openid profile email scopes) already carries name/email, avoids a network round-trip,
  // and keeps working even when the access token has been revoked out from under us.
  const { idToken } = await oktaAuth.tokenManager.getTokens();
  const claims = idToken?.claims;
  if (!claims) return null;
  return claims.name || claims.preferred_username || claims.email || null;
}

/**
 * The waiting screen. One component so the pre-hydration branch and the signing-in branch render
 * byte-identical markup — that is what makes gating hydration on it safe.
 */
function SigningIn() {
  return (
    <div className="min-h-screen flex items-center justify-center gradient-subtle">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
        <span className="text-sm text-muted-foreground tracking-wide">
          Signing in with Okta...
        </span>
      </div>
    </div>
  );
}

export default function OktaAuthWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isClient, setIsClient] = useState(false);
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsClient(true);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    const localDev =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (localDev || !HAS_OKTA_CONFIG) {
      setReady(true);
      setAuthed(true); // unauthenticated pass-through (parity with Entra local-dev)
      return;
    }
    // Nothing here can cancel an in-flight SDK call, so this timer does not abort the handshake.
    // What it does is guarantee the UI always reaches a state that explains itself. Without it, any
    // hang inside the SDK presents as a spinner that never resolves and says nothing.
    let decided = false;
    const stallTimer = window.setTimeout(() => {
      if (decided) return;
      console.error("[Okta] auth handshake stalled");
      setError(
        `Okta did not respond within ${AUTH_HANDSHAKE_TIMEOUT_MS / 1000} seconds.`,
      );
      setReady(true);
    }, AUTH_HANDSHAKE_TIMEOUT_MS);

    (async () => {
      try {
        // Inside the try: oktaRedirectUri() throws on a malformed pinned URI, and that belongs
        // in the error state below rather than as an unhandled render-time exception.
        const oktaAuth = getOktaInstance();
        if (oktaAuth.isLoginRedirect()) {
          await oktaAuth.handleLoginRedirect();
        }
        if (await oktaAuth.isAuthenticated()) {
          // Arms the token manager's expiry timers. Nothing else does: the SDK sets them up in
          // `start()` only (see core/mixin.ts), so without this call `tokenManager` never emits
          // `expired`, the listener below never fires, `autoRemove` never drops a dead token, and
          // the app's only notice of an expired session is a 401 from the BFF.
          await oktaAuth.start();
          decided = true;
          setAuthed(true);
          setReady(true);
          return;
        }
        // Decided before awaiting, not after: the redirect resolves as the page unloads, and a
        // slow unload must not be mistaken for a stall.
        decided = true;
        await oktaAuth.signInWithRedirect({
          // Come back to the page that was asked for, not the dashboard. This is what makes the
          // expiry path below a blip rather than a navigation the user has to undo.
          originalUri: window.location.href,
        });
      } catch (err) {
        decided = true;
        console.error("[Okta] auth failed:", err);
        setError(err instanceof Error ? err.message : String(err));
        setReady(true);
      }
    })();

    return () => window.clearTimeout(stallTimer);
  }, [isClient]);

  // Keeping the session alive while the app is open, and what to do when it cannot be kept alive.
  //
  // Two mechanisms, in order of preference:
  //
  //  1. `startSilentRenew` renews shortly BEFORE expiry using the refresh token. That is a POST to
  //     /token, which the CSP already allows and the user never sees — the reason `offline_access`
  //     is requested at all.
  //  2. the token manager's `expired` event, as a backstop for a renewal that did not happen: a
  //     laptop asleep through its own timer, or an Okta configuration that grants no refresh token.
  //     It tries the same POST once before giving up.
  //
  // Giving up means a top-level re-auth. Dropping `authed` first unmounts the children, which stops
  // any polling that would otherwise fire a burst of 401s straight through the redirect.
  //
  // `expired` and not `removed`: signOut() clears tokens too, and reacting to that would race a
  // sign-in redirect against the logout redirect.
  useEffect(() => {
    if (!isClient || !authed || !HAS_OKTA_CONFIG) return;
    const oktaAuth = getOktaInstance();

    /** Last resort: hand the browser to Okta and return to the page the user was on. */
    const reauth = (reason: string): void => {
      console.warn(`[Okta] ${reason} — re-authenticating`);
      setAuthed(false);
      reauthenticate("expired")
        .then((started) => {
          if (started) return;
          // The redirect was refused (see reauthenticate's loop guard). Say so rather than sitting
          // on a spinner that never explains itself.
          setError(
            "Your session expired, and signing in again did not fix it. " +
              "The API may be rejecting valid tokens — check the browser console.",
          );
          setReady(true);
        })
        .catch((err: unknown) => {
          console.error("[Okta] re-authentication failed:", err);
          setError(err instanceof Error ? err.message : String(err));
          setReady(true);
        });
    };

    const stopRenew = startSilentRenew({ oktaAuth, onUnrecoverable: reauth });

    const onExpired = (key: string) => {
      // Async, and deliberately not awaited by the SDK: one more attempt at the POST, because
      // reaching here means the scheduled renewal did not run rather than that renewal is
      // impossible. Only if that also fails does the user get a navigation.
      void (async () => {
        if ((await renewWithRefreshToken(oktaAuth)) === "renewed") {
          console.warn(`[Okta] ${key} expired and was renewed`);
          return;
        }
        reauth(`${key} expired and could not be renewed`);
      })();
    };
    oktaAuth.tokenManager.on("expired", onExpired);
    return () => {
      stopRenew();
      oktaAuth.tokenManager.off("expired", onExpired);
    };
  }, [isClient, authed]);

  // Pre-hydration renders the waiting screen, NOT the children. Rendering children here mounts the
  // whole protected app before auth is known: their effects fire immediately, so every page load
  // makes an API call with whatever stale token is in storage — a pair of 401s, plus a flash of
  // protected UI to a signed-out user. The server and the first client render agree because both
  // render <SigningIn />.
  if (!isClient) return <SigningIn />;
  if (error) {
    // The common cause of reaching here is a redirect URI that is not registered on the Okta app,
    // which happens whenever the CloudFront domain changes. Without the URI on screen the symptom is
    // a bare spinner; naming it turns a long investigation into a copy-paste, so show it — it is a
    // public callback URL, not a secret.
    return (
      <div className="min-h-screen flex items-center justify-center gradient-subtle p-6">
        <div className="max-w-xl flex flex-col gap-3 text-center">
          <span className="text-base font-medium">
            Could not sign in with Okta
          </span>
          <span className="text-sm text-muted-foreground">{error}</span>
          <span className="text-sm text-muted-foreground">
            This app asks Okta to return to{" "}
            <code className="font-mono">{describeRedirectUri()}</code>. Okta
            rejects any redirect URI that is not registered on the OIDC app, so
            confirm that exact URL is listed under the app&apos;s Sign-in
            redirect URIs.
            {!OKTA_REDIRECT_URI_IS_PINNED && (
              <>
                {" "}
                It is currently derived from this browser&apos;s address, so it
                changes if the app moves to a new domain — set{" "}
                <code className="font-mono">
                  NEXT_PUBLIC_OKTA_REDIRECT_URI
                </code>{" "}
                to pin it.
              </>
            )}
          </span>
          {/* The way out. Every error above is one a fresh sign-in might clear, and without a
              control here the only option is for the user to guess that reloading helps. Plain
              classes rather than the shared <Button>: this gate renders before the app's UI layer
              and should not fail with it. */}
          <button
            type="button"
            onClick={() => {
              setError(null);
              setReady(false);
              reauthenticate("user").then(
                (started) => {
                  if (!started) {
                    setError(
                      "This build has no Okta issuer or client id configured, so there is " +
                        "nowhere to sign in. Check the console for details.",
                    );
                    setReady(true);
                  }
                },
                (err: unknown) => {
                  setError(err instanceof Error ? err.message : String(err));
                  setReady(true);
                },
              );
            }}
            className="mt-1 self-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
          >
            Sign in again
          </button>
        </div>
      </div>
    );
  }
  if (!ready || !authed) return <SigningIn />;
  return <>{children}</>;
}

"use client";

import { useEffect, useState } from "react";

import {
  COGNITO_REDIRECT_URI_IS_PINNED,
  HAS_COGNITO_CONFIG,
  buildLoginUrl,
  cognitoRedirectUri,
  currentIdToken,
  decodeJwtClaims,
  exchangeCode,
  isLoginRedirect,
  logout,
} from "@/lib/auth/cognito-pkce";
import { reauthenticate } from "@/lib/reauth";

/**
 * Amazon Cognito auth gate — the DEFAULT provider, active when `NEXT_PUBLIC_AUTH_PROVIDER` is unset
 * or set to `cognito`. Same shape as OktaAuthWrapper and EntraAuthWrapper: a client-hydration guard,
 * a pass-through for local dev and unconfigured builds, and children rendered only once there is a
 * session. The one difference from the other two is that a hosted-UI redirect is completed even on
 * `localhost`, before the pass-through — see the effect below for why that is not optional here.
 * It handles the hosted UI redirect itself (`?code=` in the URL) for the same reason the
 * Okta wrapper does: it renders before every page, so if it did not complete the exchange it would
 * send the browser back to `/authorize` while sitting on the callback URL. `src/app/callback/page.tsx`
 * is the page underneath it and only forwards the now-authenticated user onwards.
 *
 * There is no renewal service here, unlike the Okta path. `lib/auth/cognito-pkce.ts` refreshes on
 * read, so every BFF call renews the token when it needs to; see `currentIdToken` for why that is
 * preferred over a timer.
 */

/**
 * How long the sign-in handshake may take before the UI stops waiting and explains itself.
 *
 * Matches the Okta wrapper. The number bounds the wait so a hang always reaches a state that says
 * something, rather than racing the one network call on this path (the code-for-token POST).
 */
const AUTH_HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * The redirect URI as a human-readable string for the error state.
 *
 * Separate from `cognitoRedirectUri()` because that throws on a malformed pinned value, and the
 * error screen must be able to render the bad value rather than blow up while explaining it.
 */
function describeRedirectUri(): string {
  try {
    return cognitoRedirectUri() || "(unknown)";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Sign out through the hosted UI's `/logout`.
 *
 * Rejects rather than doing nothing when Cognito is unconfigured, which is what
 * `lib/shell/signOut.ts` relies on to show the user a reason (the other two providers' SDKs behave
 * the same way).
 */
export async function cognitoSignOut(): Promise<void> {
  logout();
}

/**
 * The signed-in user's display name from the ID token's claims, or null.
 *
 * Read from the token this tab already holds rather than from `/oauth2/userInfo`: the claims are
 * there, it costs no round trip, and it keeps working when the pool session has already ended.
 */
export async function cognitoUserName(): Promise<string | null> {
  const token = await currentIdToken();
  if (!token) return null;
  const claims = decodeJwtClaims(token);
  if (!claims) return null;
  // In preference order: what a federated IdP maps in, what a pool-local user signed up with, then
  // the pool's own username as a last resort.
  for (const key of ["name", "email", "preferred_username", "cognito:username"]) {
    const value = claims[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
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
          Signing in...
        </span>
      </div>
    </div>
  );
}

export default function CognitoAuthWrapper({
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
    // The unauthenticated pass-through, and the one case that must be handled BEFORE it: a hosted UI
    // redirect already sitting in the URL.
    //
    // A build with no Cognito configuration passes through unconditionally — there is nothing to
    // exchange a code with. `localhost` passes through too, matching the Okta and Entra wrappers, so
    // `npm run dev` renders immediately and the gate never starts a redirect on its own.
    //
    // But a laptop CAN arrive here holding a real `?code=`: the 401 backstop in `lib/reauth.ts` starts
    // the hosted-UI redirect when the BFF refuses an anonymous call, and the deployment registers
    // `http://localhost:<port>/callback` on the app client for exactly that (`cognito_local_dev_callbacks`).
    // Returning before the exchange dropped that code silently, so the token was never obtained, the
    // next call 401'd again, and the redirect repeated on a 60-second cooldown forever — with the
    // localhost callback URL registered on a live pool buying nothing at all.
    if (!HAS_COGNITO_CONFIG || (localDev && !isLoginRedirect())) {
      setReady(true);
      setAuthed(true);
      return;
    }
    // Nothing here can cancel an in-flight fetch, so this timer does not abort the handshake. What
    // it does is guarantee the UI always reaches a state that explains itself.
    let decided = false;
    const stallTimer = window.setTimeout(() => {
      if (decided) return;
      console.error("[Cognito] auth handshake stalled");
      setError(
        `Cognito did not respond within ${AUTH_HANDSHAKE_TIMEOUT_MS / 1000} seconds.`,
      );
      setReady(true);
    }, AUTH_HANDSHAKE_TIMEOUT_MS);

    (async () => {
      try {
        const params = new URLSearchParams(window.location.search);
        const refusal = params.get("error");
        if (refusal) {
          // The hosted UI refused: an unconfirmed account, a disabled user, a federation failure.
          // `error_description` is where Cognito puts the sentence worth showing.
          throw new Error(
            [refusal, params.get("error_description")].filter(Boolean).join(": "),
          );
        }
        const code = params.get("code");
        if (code) {
          // Verifies `state` against what this tab stored before exchanging anything.
          await exchangeCode(code, params.get("state"));
        }
        if (await currentIdToken()) {
          decided = true;
          setAuthed(true);
          setReady(true);
          return;
        }
        if (localDev) {
          // Only reachable when a laptop landed on the callback and the exchange produced no session.
          // Pass through rather than redirecting: `npm run dev` would otherwise bounce through the
          // hosted UI on every load, and anonymous mode (ALLOW_ANONYMOUS_API) is a legitimate way to
          // run locally with no session at all.
          decided = true;
          setAuthed(true);
          setReady(true);
          return;
        }
        // Decided before awaiting, not after: the redirect resolves as the page unloads, and a slow
        // unload must not be mistaken for a stall.
        decided = true;
        // Come back to the page that was asked for, not the console landing.
        window.location.assign(await buildLoginUrl(window.location.href));
      } catch (err) {
        decided = true;
        console.error("[Cognito] auth failed:", err);
        setError(err instanceof Error ? err.message : String(err));
        setReady(true);
      }
    })();

    return () => window.clearTimeout(stallTimer);
  }, [isClient]);

  // Pre-hydration renders the waiting screen, NOT the children. Rendering children here mounts the
  // whole protected app before auth is known: their effects fire immediately, so every page load
  // makes an API call with whatever stale token is in storage — a pair of 401s, plus a flash of
  // protected UI to a signed-out user. The server and the first client render agree because both
  // render <SigningIn />.
  if (!isClient) return <SigningIn />;
  if (error) {
    // The likeliest cause of reaching here is a callback URL that is not listed on the app client,
    // which happens whenever the CloudFront domain changes. Naming the URI turns a long investigation
    // into a copy-paste; it is a public callback URL, not a secret.
    return (
      <div className="min-h-screen flex items-center justify-center gradient-subtle p-6">
        <div className="max-w-xl flex flex-col gap-3 text-center">
          <span className="text-base font-medium">Could not sign in</span>
          <span className="text-sm text-muted-foreground">{error}</span>
          <span className="text-sm text-muted-foreground">
            This app asks Cognito to return to{" "}
            <code className="font-mono">{describeRedirectUri()}</code>. A user
            pool only redirects to a URL listed verbatim under the app
            client&apos;s allowed callback URLs, so confirm that exact URL is
            there.
            {!COGNITO_REDIRECT_URI_IS_PINNED && (
              <>
                {" "}
                It is currently derived from this browser&apos;s address, so it
                changes if the app moves to a new domain — set{" "}
                <code className="font-mono">
                  NEXT_PUBLIC_COGNITO_REDIRECT_URI
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
                      "This build has no Cognito hosted UI domain or client id configured, so " +
                        "there is nowhere to sign in. Check the console for details.",
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

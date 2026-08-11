/**
 * Okta OIDC configuration. Active when NEXT_PUBLIC_AUTH_PROVIDER === 'okta'.
 *
 * Replaces Cognito/Entra as the identity provider when configured. Live login requires an Okta
 * org + OIDC app (issuer + client id); with the env vars unset the app runs unauthenticated
 * (local dev / build) exactly like the Entra path.
 */
const issuer = process.env.NEXT_PUBLIC_OKTA_ISSUER ?? "";
const clientId = process.env.NEXT_PUBLIC_OKTA_CLIENT_ID ?? "";

/**
 * Operator-pinned callback URL, baked in at build time. Empty means "derive it from whatever
 * origin the browser happens to be on" — see `oktaRedirectUri`.
 */
const pinnedRedirectUri = (
  process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI ?? ""
).trim();

export const HAS_OKTA_CONFIG = !!(issuer && clientId);

/** The OIDC callback route this app serves; the redirect URI must point at it. */
const CALLBACK_PATH = "/login/callback";

/** True when the callback URL is pinned by configuration rather than sniffed from the browser. */
export const OKTA_REDIRECT_URI_IS_PINNED = !!pinnedRedirectUri;

/**
 * Redirect URI Okta returns to after login (the app's OIDC callback).
 *
 * `NEXT_PUBLIC_OKTA_REDIRECT_URI` wins when set. That precedence is the fix for live-QA finding
 * P0-1: deriving the URI from `window.location.origin` alone means it silently becomes whatever
 * host the app is served from, and this deployment's public host is a generated
 * `*.cloudfront.net` domain that changes whenever the distribution is recreated. Okta only
 * redirects to URIs pre-registered on the app, so every such rebuild broke login until someone
 * re-registered the new domain by hand — and the failure looked like a hung spinner, not a
 * configuration error. Pinning it to a stable URL (a custom domain, or a distribution domain you
 * intend to keep) makes the registered value and the requested value the same by construction.
 *
 * The origin-derived fallback is retained deliberately: it is what makes `next dev` on
 * localhost work with no configuration at all.
 *
 * @returns the absolute callback URL, or "" when called during SSR with nothing pinned.
 * @throws Error when the pinned value is not an absolute URL ending in the callback path — a
 *   typo here is otherwise invisible until Okta rejects the login with its own opaque error.
 */
export function oktaRedirectUri(): string {
  if (pinnedRedirectUri) {
    // Trailing slash tolerated (operators copy URLs out of browsers) — nothing else is.
    const normalized = pinnedRedirectUri.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(normalized)) {
      throw new Error(
        `NEXT_PUBLIC_OKTA_REDIRECT_URI must be an absolute URL (got "${pinnedRedirectUri}")`,
      );
    }
    if (!normalized.endsWith(CALLBACK_PATH)) {
      throw new Error(
        `NEXT_PUBLIC_OKTA_REDIRECT_URI must end with ${CALLBACK_PATH} ` +
          `(got "${pinnedRedirectUri}")`,
      );
    }
    return normalized;
  }
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${CALLBACK_PATH}`;
}

export const oktaConfig = {
  issuer,
  clientId,
  scopes: ["openid", "profile", "email"],
  pkce: true,
} as const;

/**
 * Token-manager options every `OktaAuth` in this app is constructed with. They switch the SDK's
 * iframe-based silent renew OFF, and they live here rather than at one construction site because
 * there are three (the auth wrapper, `recon-auth.ts`, `reauth.ts`) and whichever runs first wins.
 *
 * `autoRenew` defaults to true, and with no `offline_access` scope there is no refresh token, so
 * renewal falls back to loading /authorize in a hidden iframe. The CloudFront CSP is
 * `default-src 'self'` with no `frame-src`, so the frame never loads, no postMessage arrives, and
 * `isAuthenticated()` waits out the SDK's 120 s timeout — once per token — before finally
 * returning false. That is the several minutes of unexplained "Signing in with Okta..." this
 * removes; `reauthenticate()` in `reauth.ts` explains why the answer is a top-level redirect
 * rather than a `frame-src` allowance.
 *
 * `autoRemove` stays on so an expired token is dropped instead of being sent to the BFF for a 401.
 *
 * These go in `tokenManager` rather than `services` deliberately: the SDK's ServiceManager reads
 * `autoRenew`/`autoRemove`/`syncStorage` from the token manager's options, so setting them here
 * also stops the background AutoRenewService from firing its own blocked-iframe renews on a timer.
 */
export const oktaTokenManagerOptions = {
  autoRenew: false,
  autoRemove: true,
} as const;

/**
 * Okta OIDC configuration. Active when NEXT_PUBLIC_AUTH_PROVIDER === 'okta'.
 *
 * Replaces Entra as the identity provider when configured. Live login requires an Okta
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
 * `NEXT_PUBLIC_OKTA_REDIRECT_URI` wins when set, and that precedence is load-bearing: deriving the
 * URI from `window.location.origin` alone means it silently becomes whatever host the app is served
 * from, and this deployment's public host is a generated `*.cloudfront.net` domain that changes
 * whenever the distribution is recreated. Okta only redirects to URIs pre-registered on the app, so
 * every such rebuild breaks login until someone re-registers the new domain by hand — and the
 * failure looks like a hung spinner, not a configuration error. Pinning it to a stable URL (a custom
 * domain, or a distribution domain you intend to keep) makes the registered value and the requested
 * value the same by construction.
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

/**
 * Scopes requested at /authorize.
 *
 * `offline_access` is what asks Okta for a REFRESH TOKEN, and it is the difference between a
 * session that renews itself in the background and one that bounces the user through a full
 * sign-in redirect every time a token ages out. Ticking "Refresh Token" on the Okta app only
 * *permits* the grant; the client still has to request it, and on this deployment's issuer — a
 * custom authorization server, path `/oauth2/default` — the server's access-policy RULE has to
 * grant the scope as well. Without all three, the token response simply arrives with no
 * `refresh_token` in it and nothing anywhere reports an error.
 *
 * A build whose refresh token never materialises is not broken: `okta-renew.ts` checks for one
 * before renewing, so the app falls back to the top-level redirect it used before.
 */
export const oktaConfig = {
  issuer,
  clientId,
  scopes: ["openid", "profile", "email", "offline_access"],
  pkce: true,
} as const;

/**
 * Token-manager options every `OktaAuth` in this app is constructed with. They live here rather
 * than at one construction site because there are three (the auth wrapper, `recon-auth.ts`,
 * `reauth.ts`) and whichever runs first wins.
 *
 * `autoRenew: false` deliberately, even though renewal is now wanted. It is what makes the SDK's
 * iframe-based renewal UNREACHABLE: both paths that could reach it — `AutoRenewService`, which
 * renews on the token manager's `expired` event, and `RenewOnTabActivationService`, which renews
 * when a long-hidden tab comes back — gate `canStart()` on this flag. Renewal is done explicitly
 * in `okta-renew.ts` instead, which checks a refresh token is present first and therefore only
 * ever POSTs to /token.
 *
 * That distinction matters because whether a refresh token exists depends on Okta-side policy this
 * build cannot see (see `oktaConfig.scopes`). Leaving the SDK to decide would mean a deployment
 * whose policy has not been updated falls back to an iframe that `default-src 'self'` blocks, no
 * postMessage ever arrives, and `isAuthenticated()` waits out the SDK's 120 s timeout — once per
 * token. That is the several minutes of unexplained "Signing in with Okta..." that must not come
 * back; `reauthenticate()` in `reauth.ts` explains why the fallback is a top-level redirect rather
 * than a `frame-src` allowance.
 *
 * `autoRemove` stays on so an expired token is dropped instead of being sent to the BFF for a 401.
 * Note that it only takes effect once something calls `oktaAuth.start()` — see the wrapper.
 *
 * These go in `tokenManager` rather than `services` deliberately: the SDK's ServiceManager reads
 * `autoRenew`/`autoRemove`/`syncStorage` from the token manager's options.
 */
export const oktaTokenManagerOptions = {
  autoRenew: false,
  autoRemove: true,
} as const;

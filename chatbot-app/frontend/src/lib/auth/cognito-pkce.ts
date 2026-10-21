/**
 * Sign-in against an Amazon Cognito user pool's hosted UI (managed login): OAuth 2.0
 * authorization-code flow with PKCE, written against the platform `crypto` and `fetch`.
 *
 * No SDK, on purpose. `amazon-cognito-identity-js` is deprecated, `aws-amplify` pulls a framework in
 * to do this, and `oidc-client-ts` is a third dependency for ninety lines of URLSearchParams. The
 * flow below is the whole of it, and being able to read it is part of what this sample is for.
 *
 * Where this sits: this module owns the BROWSER half of the Cognito path — the redirect out, the
 * code-for-token exchange, and the tokens afterwards. `components/CognitoAuthWrapper.tsx` is the gate
 * that drives it, `lib/auth/client-token.ts` reads the ID token out of it for every BFF call, and
 * `lib/api-auth.ts` is the server that verifies that token against the same pool. One pool, one
 * client id, one identity provider — which is the difference between this and the Cognito that used
 * to be here (a pool nobody signed in through, whose only job was to issue tokens for the intake API
 * while the console signed in through Okta; its hosted UI was orphaned and it was rightly deleted).
 *
 * PKCE with no client secret is the correct shape for a browser client: the app client on the pool
 * must be created WITHOUT a secret, and there is consequently no credential in this file to leak.
 * Everything configurable arrives as a `NEXT_PUBLIC_*` build argument.
 *
 * Two things the predecessor of this file got wrong, both fixed here and both worth naming:
 *  1. it sent no `state` parameter, so a `/callback?code=...` link an attacker crafted would be
 *     exchanged by the victim's browser as if the victim had started the login. `state` is now
 *     generated per attempt, stored next to the verifier, and REQUIRED to match on return.
 *  2. it never stored the tokens it exchanged, so the app signed in and then had nothing to send.
 *
 * Storage: `sessionStorage`, per tab, cleared when the tab closes. The refresh token therefore does
 * not outlive the tab, which is the reason for choosing it over `localStorage` (what MSAL and
 * okta-auth-js use, and what would keep a long-lived credential readable by any script until it
 * expires). The cost is that a NEW tab has no session and bounces through `/oauth2/authorize` once —
 * silent, because the pool's own session cookie is first-party on the hosted UI domain. The
 * production-grade alternative, holding tokens in an HttpOnly cookie issued by a server-side
 * session route, is a different architecture: it needs BFF endpoints and a session store, and it
 * would leave this app's three providers behaving differently from one another.
 */

/** Tokens exactly as the Cognito token endpoint returns them (snake_case is the wire format). */
export interface CognitoTokens {
  id_token: string;
  access_token?: string;
  /** Absent from a refresh-grant response: Cognito does not rotate the refresh token. */
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

/**
 * `sessionStorage` keys. Prefixed like the existing `recon.auth.*` key in `lib/reauth.ts` so
 * everything this app writes to per-tab storage is identifiable at a glance in devtools.
 */
export const COGNITO_KEYS = {
  /** The PKCE code verifier, until the exchange consumes it. */
  verifier: "recon.cognito.pkceVerifier",
  /** The CSRF `state` value, until the exchange verifies it. */
  state: "recon.cognito.state",
  /** The token set for this tab. */
  tokens: "recon.cognito.tokens",
  /** Where to send the user once the callback completes. */
  returnTo: "recon.cognito.returnTo",
} as const;

/** The route this app serves the redirect on; the app client's callback URL must point at it. */
export const COGNITO_CALLBACK_PATH = "/callback";

/**
 * Scopes requested at `/authorize`.
 *
 * No `offline_access`: unlike Okta, Cognito issues a refresh token whenever the app client permits
 * the refresh-token grant, and asking for a scope the pool does not define is an `invalid_scope`
 * error rather than a no-op.
 */
export const COGNITO_SCOPES = "openid profile email";

/**
 * How close to expiry the ID token may be before a read refreshes it instead of returning it.
 *
 * At least the BFF's own `clockTolerance` (60s in `lib/api-auth.ts`), so the token this app hands
 * out is one the server will still accept if the two clocks disagree by the maximum it tolerates.
 */
const REFRESH_SKEW_MS = 60_000;

const rawHostedUi = (process.env.NEXT_PUBLIC_COGNITO_HOSTED_UI ?? "").trim();
const clientId = (process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? "").trim();
const pinnedRedirectUri = (
  process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI ?? ""
).trim();
const region = (process.env.NEXT_PUBLIC_AWS_REGION ?? "").trim() || "us-east-1";

/**
 * Whether this build can sign in with Cognito at all.
 *
 * Same contract as `HAS_OKTA_CONFIG` / `HAS_ENTRA_CONFIG`: false means the wrapper renders its
 * children unauthenticated, which is what makes a laptop with no Cognito variables usable.
 */
export const HAS_COGNITO_CONFIG = !!(rawHostedUi && clientId);

/** True when the callback URL is pinned by configuration rather than read off the browser's address. */
export const COGNITO_REDIRECT_URI_IS_PINNED = !!pinnedRedirectUri;

/** The app client id, for the wrapper's error text. Never a secret — it is in the URL bar at login. */
export const COGNITO_CLIENT_ID = clientId;

/**
 * Origin of the hosted UI, e.g. `https://example-login.auth.us-east-1.amazoncognito.com`.
 *
 * `NEXT_PUBLIC_COGNITO_HOSTED_UI` may be given three ways, because operators copy this value out of
 * three different places in the console: the full domain, the same thing with an `https://` on the
 * front, or just the domain PREFIX. A value with no dot in it can only be a prefix, so it is expanded
 * with `NEXT_PUBLIC_AWS_REGION` — which is why that variable is read here at all. A custom domain
 * (`login.example.com`) contains dots and is used as given.
 *
 * @returns the origin with no trailing slash, or "" when nothing is configured.
 */
export function cognitoHostedUiOrigin(): string {
  const bare = rawHostedUi.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  if (!bare) return "";
  const domain = bare.includes(".")
    ? bare
    : `${bare}.auth.${region}.amazoncognito.com`;
  return `https://${domain}`;
}

/**
 * Redirect URI the hosted UI returns to.
 *
 * Defaults to `${window.location.origin}${COGNITO_CALLBACK_PATH}` so a deployment works behind a
 * generated `*.cloudfront.net` domain that is not known when the image is built — the same reason the
 * Okta path derives its default, and the reason this is not simply a required variable.
 * `NEXT_PUBLIC_COGNITO_REDIRECT_URI` pins it when the app is reachable on more than one host (a
 * custom domain plus the distribution domain), because Cognito only redirects to a URL listed
 * verbatim on the app client.
 *
 * @returns the absolute callback URL, or "" during SSR with nothing pinned.
 * @throws Error when the pinned value is not an absolute URL ending in the callback path. A typo is
 *   otherwise invisible until Cognito answers `redirect_mismatch` with no further explanation.
 */
export function cognitoRedirectUri(): string {
  if (pinnedRedirectUri) {
    // Trailing slash tolerated (operators paste URLs out of browsers) — nothing else is.
    const normalized = pinnedRedirectUri.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(normalized)) {
      throw new Error(
        `NEXT_PUBLIC_COGNITO_REDIRECT_URI must be an absolute URL (got "${pinnedRedirectUri}")`,
      );
    }
    if (!normalized.endsWith(COGNITO_CALLBACK_PATH)) {
      throw new Error(
        `NEXT_PUBLIC_COGNITO_REDIRECT_URI must end with ${COGNITO_CALLBACK_PATH} ` +
          `(got "${pinnedRedirectUri}")`,
      );
    }
    return normalized;
  }
  if (typeof window === "undefined") return "";
  return `${window.location.origin}${COGNITO_CALLBACK_PATH}`;
}

/** base64url, the encoding RFC 7636 requires for the verifier and challenge. */
function base64Url(bytes: Uint8Array): string {
  let binary = "";
  // Not `String.fromCharCode(...bytes)`: spreading a large array blows the argument limit, and this
  // function is also used on digests, so keep it size-independent.
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** 32 random bytes, base64url — 43 characters, the length RFC 7636 recommends for a verifier. */
function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * A PKCE verifier and its S256 challenge.
 *
 * S256 rather than `plain`: the verifier travels only on the back-channel POST, so an attacker who
 * captures the front-channel redirect (a proxy log, a referrer, the address bar) gets a hash they
 * cannot use. Cognito accepts `plain` and there is no reason to let it.
 */
async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomToken();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

/** The tab's session storage, or null during SSR. */
function store(): Storage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

/**
 * Build the hosted UI authorize URL, recording the PKCE verifier, the `state` and where to return.
 *
 * @param returnTo absolute URL to come back to after the callback; defaults to the current page, so
 *   a user who deep-linked into an app lands where they asked rather than on the console landing.
 * @returns the URL to navigate to.
 * @throws Error when the pinned redirect URI is malformed (see `cognitoRedirectUri`).
 */
export async function buildLoginUrl(returnTo?: string): Promise<string> {
  const origin = cognitoHostedUiOrigin();
  const redirectUri = cognitoRedirectUri();
  const { verifier, challenge } = await pkcePair();
  const state = randomToken(16);
  const s = store();
  if (s) {
    s.setItem(COGNITO_KEYS.verifier, verifier);
    s.setItem(COGNITO_KEYS.state, state);
    s.setItem(COGNITO_KEYS.returnTo, returnTo ?? window.location.href);
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: COGNITO_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${origin}/oauth2/authorize?${params.toString()}`;
}

/** POST to the hosted UI token endpoint and return the parsed token set. */
async function postToken(body: Record<string, string>): Promise<CognitoTokens> {
  const response = await fetch(`${cognitoHostedUiOrigin()}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    // Cognito's failure body is `{"error":"invalid_grant"}`; surface it, because the status alone
    // does not distinguish a reused code from a mismatched redirect URI.
    let detail = response.statusText;
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) detail = parsed.error;
    } catch {
      // Not JSON (a gateway page). The status is still worth reporting.
    }
    throw new Error(`Cognito token endpoint returned ${response.status}: ${detail}`);
  }
  const tokens = (await response.json()) as CognitoTokens;
  if (!tokens?.id_token) {
    throw new Error("Cognito token response carried no id_token");
  }
  return tokens;
}

/**
 * The exchange for the code currently being redeemed, so a second call with the SAME code is the
 * same operation rather than a second attempt.
 *
 * An authorization code is single-use and the verifier is consumed with it, so a repeat call could
 * only ever fail — and it would fail as "state did not match", which reads like a security problem
 * rather than a double invocation. React's StrictMode runs effects twice in development, and any
 * remount of the gate while `?code=` is still in the URL has the same shape.
 */
let inflightExchange: { code: string; tokens: Promise<CognitoTokens> } | null =
  null;

/**
 * Exchange an authorization code for tokens, verifying `state` first.
 *
 * Idempotent per code: calling it twice with the same code yields the same result (or the same
 * failure) instead of burning the handshake.
 *
 * @param code the `code` query parameter from the callback.
 * @param state the `state` query parameter. Omit to read it from the current URL.
 * @returns the token set, already stored for `client-token.ts` to read.
 * @throws Error when `state` does not match what this tab stored, when the verifier is missing, or
 *   when the token endpoint refuses the exchange.
 */
export function exchangeCode(
  code: string,
  state?: string | null,
): Promise<CognitoTokens> {
  if (inflightExchange?.code === code) return inflightExchange.tokens;
  const tokens = performExchange(code, state);
  inflightExchange = { code, tokens };
  return tokens;
}

async function performExchange(
  code: string,
  state?: string | null,
): Promise<CognitoTokens> {
  const s = store();
  const expectedState = s?.getItem(COGNITO_KEYS.state) ?? null;
  const receivedState =
    state === undefined
      ? new URLSearchParams(window.location.search).get("state")
      : state;
  const verifier = s?.getItem(COGNITO_KEYS.verifier) ?? "";
  // Consume both BEFORE deciding, and whatever the decision is. A verifier or a state left in
  // storage after a failed attempt is reusable, and reuse is precisely what a replayed code needs.
  s?.removeItem(COGNITO_KEYS.state);
  s?.removeItem(COGNITO_KEYS.verifier);

  if (!expectedState || !receivedState || receivedState !== expectedState) {
    // The CSRF check. A code this tab did not ask for is refused here rather than exchanged and
    // silently adopted as the user's session.
    throw new Error(
      "Cognito sign-in state did not match this tab's request. Start the sign-in again.",
    );
  }
  if (!verifier) {
    throw new Error(
      "Cognito sign-in verifier is missing from this tab. Start the sign-in again.",
    );
  }

  const tokens = await postToken({
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: cognitoRedirectUri(),
    code_verifier: verifier,
  });
  storeTokens(tokens);
  return tokens;
}

/** The token set this tab holds, or null when there is none or it is unreadable. */
export function readStoredTokens(): CognitoTokens | null {
  const raw = store()?.getItem(COGNITO_KEYS.tokens);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CognitoTokens;
    return typeof parsed?.id_token === "string" && parsed.id_token
      ? parsed
      : null;
  } catch {
    // Something else wrote the key, or storage is corrupt. Treat it as no session rather than
    // throwing out of a token read.
    return null;
  }
}

/**
 * Store a token set, keeping the refresh token a refresh-grant response omits.
 *
 * Cognito returns no `refresh_token` when refreshing (it does not rotate them), so a naive
 * overwrite would drop the only credential that can renew the session — the session would then die
 * at the first ID-token expiry instead of at the refresh token's.
 */
function storeTokens(tokens: CognitoTokens): void {
  const s = store();
  if (!s) return;
  const existing = readStoredTokens();
  const merged: CognitoTokens = {
    ...tokens,
    refresh_token: tokens.refresh_token ?? existing?.refresh_token,
  };
  s.setItem(COGNITO_KEYS.tokens, JSON.stringify(merged));
}

/** Forget this tab's tokens and any half-finished handshake. */
export function clearTokens(): void {
  const s = store();
  if (!s) return;
  s.removeItem(COGNITO_KEYS.tokens);
  s.removeItem(COGNITO_KEYS.verifier);
  s.removeItem(COGNITO_KEYS.state);
}

/** Whether this tab holds a token set at all (it may still be expired). */
export function hasStoredSession(): boolean {
  return readStoredTokens() !== null;
}

/**
 * Where the user asked to go before being sent to the hosted UI, as a path; cleared as it is read.
 *
 * Always a SAME-ORIGIN path, never the stored string as-is. The value came out of this tab's own
 * `sessionStorage`, but a redirect target read from storage and navigated to unchecked is an
 * open-redirect gadget one stray `setItem` away, and nothing about "come back to the page you asked
 * for" needs cross-origin navigation. The callback path itself is refused too: returning there would
 * re-run the callback with no code in the URL.
 *
 * @returns a path beginning with `/`, defaulting to the console landing.
 */
export function consumeReturnTo(): string {
  const s = store();
  const raw = s?.getItem(COGNITO_KEYS.returnTo) ?? null;
  s?.removeItem(COGNITO_KEYS.returnTo);
  if (!raw || typeof window === "undefined") return "/";
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (!path.startsWith("/")) return "/";
    return path === COGNITO_CALLBACK_PATH ||
      path.startsWith(`${COGNITO_CALLBACK_PATH}?`)
      ? "/"
      : path;
  } catch {
    return "/";
  }
}

/**
 * A JWT's claims, decoded but NOT verified.
 *
 * The signature is the BFF's business (`lib/api-auth.ts`), and a browser that trusted these claims
 * for anything but presentation would be deciding its own authorization. The two callers are honest
 * about that: "should I refresh?" (below) and "what name goes in the header?" — a wrong answer to
 * either costs a redundant refresh or a wrong label, never access.
 *
 * @returns the claims, or null when the token is not a decodable JWT.
 */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const padded = segment
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as unknown;
    return claims && typeof claims === "object"
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The `exp` claim of a JWT, in epoch milliseconds.
 *
 * @returns the expiry, or null when the token is not a decodable JWT with a numeric `exp`.
 */
export function jwtExpiryMs(token: string): number | null {
  const exp = decodeJwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

/**
 * One in-flight refresh, shared.
 *
 * The shell and both apps can have several BFF calls in flight at once, each reading the token; N
 * simultaneous refreshes would be N token-endpoint round trips for one answer.
 */
let inflightRefresh: Promise<CognitoTokens | null> | null = null;

async function performRefresh(): Promise<CognitoTokens | null> {
  const refreshToken = readStoredTokens()?.refresh_token;
  if (!refreshToken) {
    // No way to renew: the session is over. Drop the dead ID token so the wrapper's next mount sends
    // the user to sign in instead of the app 401ing behind a UI that looks signed in.
    clearTokens();
    return null;
  }
  try {
    const tokens = await postToken({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
    storeTokens(tokens);
    return tokens;
  } catch (error) {
    console.warn("[Cognito] could not refresh the session:", error);
    clearTokens();
    return null;
  }
}

/**
 * Renew the token set with the refresh token.
 *
 * @returns the new tokens, or null when there is no refresh token or the pool refused it (in which
 *   case this tab's tokens have been cleared).
 */
export function refreshTokens(): Promise<CognitoTokens | null> {
  if (!inflightRefresh) {
    inflightRefresh = performRefresh().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

/**
 * The ID token to send to the BFF, refreshed if it has expired or is about to.
 *
 * This read-time refresh is the whole renewal strategy for the Cognito path — there is deliberately
 * no background timer. Every BFF call goes through `client-token.ts` → here, so a token is renewed
 * exactly when it is needed and a tab left idle costs nothing; and a refresh token that has ITSELF
 * expired surfaces as a missing header, which the 401 backstop in `authed-fetch.ts` turns into a
 * sign-in redirect. A timer would add a second mechanism that can only fail differently.
 *
 * @returns the ID token, or null when there is no usable session.
 */
export async function currentIdToken(): Promise<string | null> {
  const stored = readStoredTokens();
  if (!stored) return null;
  const expiry = jwtExpiryMs(stored.id_token);
  // An undecodable token counts as expired: it is useless to send, and the refresh path is the only
  // thing that can produce a good one.
  if (expiry !== null && expiry - Date.now() > REFRESH_SKEW_MS) {
    return stored.id_token;
  }
  return (await refreshTokens())?.id_token ?? null;
}

/**
 * The hosted UI logout URL.
 *
 * `logout_uri` is the app's own origin, matching what the Okta and Entra sign-outs use as their
 * post-logout URL. It must be listed as an allowed sign-out URL on the app client, exactly like the
 * callback URL — Cognito answers with an error page rather than redirecting otherwise.
 *
 * @returns the URL, or "" when Cognito is not configured in this build.
 */
export function cognitoLogoutUrl(): string {
  const origin = cognitoHostedUiOrigin();
  if (!origin || !clientId || typeof window === "undefined") return "";
  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: window.location.origin,
  });
  return `${origin}/logout?${params.toString()}`;
}

/**
 * Sign out: drop this tab's tokens, then end the pool session at the hosted UI.
 *
 * Local tokens go first for the reason the Okta wrapper spells out — if the redirect is then refused
 * (an unregistered sign-out URL), the app must come back signed OUT rather than holding tokens that
 * 401 every call behind a UI that still looks signed in.
 *
 * @throws Error when this build has no Cognito configuration, so the caller can say so. The other two
 *   providers' SDKs reject in the same situation and `lib/shell/signOut.ts` relies on that: a control
 *   that silently does nothing is the failure it exists to prevent.
 */
export function logout(): void {
  clearTokens();
  store()?.removeItem(COGNITO_KEYS.returnTo);
  const url = cognitoLogoutUrl();
  if (!url) {
    throw new Error(
      "Cognito is not configured in this build (NEXT_PUBLIC_COGNITO_HOSTED_UI / " +
        "NEXT_PUBLIC_COGNITO_CLIENT_ID), so there is no session to sign out of.",
    );
  }
  window.location.assign(url);
}

/**
 * Whether the current URL is a hosted UI redirect this module should handle.
 *
 * True for a success (`?code=`) and for a refusal (`?error=`), because both need handling and only
 * the second one has anything to display. The counterpart to okta-auth-js's `isLoginRedirect()`.
 */
export function isLoginRedirect(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.has("code") || params.has("error");
}

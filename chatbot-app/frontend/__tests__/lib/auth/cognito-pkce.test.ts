/**
 * The Cognito hosted UI sign-in flow: authorization code + PKCE, no SDK.
 *
 * What has to hold, in the order it matters:
 *  1. the front channel gives away nothing reusable — an S256 challenge, the verifier kept in this
 *     tab, and a `state` that is GENERATED, stored and verified on return. The predecessor of this
 *     module omitted state, which made `/callback?code=...` a working CSRF gadget: the victim's
 *     browser would exchange an attacker's code and adopt the attacker's session. Two cases below
 *     cover that directly.
 *  2. the tokens are stored and refreshed, because the same predecessor exchanged them and dropped
 *     them, so the app signed in and then had nothing to send.
 *  3. the redirect URI defaults to this browser's origin, which is what makes a deployment behind a
 *     generated CloudFront domain work without rebuilding the image.
 *
 * Everything in this module reads `NEXT_PUBLIC_*` at module load (Next inlines those at build time),
 * so each case re-imports the module with the environment it needs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scopedEnv } from "../../helpers/env";

const HOSTED_UI = "example-login.auth.us-east-1.amazoncognito.com";
const CLIENT_ID = "1example23clientid456";
const ORIGIN = "https://console.example.com";

const COGNITO_ENV_NAMES = [
  "NEXT_PUBLIC_COGNITO_HOSTED_UI",
  "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_REDIRECT_URI",
  "NEXT_PUBLIC_AWS_REGION",
];

const env = scopedEnv(COGNITO_ENV_NAMES);
const fetchMock = vi.fn();
const assign = vi.fn();

/** An in-memory sessionStorage: the shared setup installs `vi.fn()` stubs that store nothing. */
function installSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
  });
  return store;
}

/** Pretend to be served from a deployed origin, with a stubbed navigation. */
function installLocation(search = "", pathname = "/recon/dashboard"): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      origin: ORIGIN,
      hostname: "console.example.com",
      pathname,
      search,
      href: `${ORIGIN}${pathname}${search}`,
      assign,
    },
  });
}

function base64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A JWT-shaped string with the claims given. Never verified by the browser, only decoded. */
function fakeJwt(claims: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64Url(JSON.stringify(claims)),
    "signature",
  ].join(".");
}

/** An ID token that expires `seconds` from now. */
function idTokenExpiringIn(seconds: number, extra: Record<string, unknown> = {}): string {
  return fakeJwt({
    token_use: "id",
    sub: "11111111-2222-3333-4444-555555555555",
    exp: Math.floor(Date.now() / 1000) + seconds,
    ...extra,
  });
}

/** A token-endpoint success. */
function tokenResponse(body: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  } as unknown as Response;
}

/** A token-endpoint refusal, in the shape Cognito uses. */
function tokenError(status: number, error: string) {
  return {
    ok: false,
    status,
    statusText: "Bad Request",
    json: async () => ({ error }),
  } as unknown as Response;
}

type Pkce = typeof import("@/lib/auth/cognito-pkce");

/** Load the module bound to a specific environment. */
async function loadPkce(overrides: Record<string, string | undefined> = {}): Promise<Pkce> {
  env.set({
    NEXT_PUBLIC_COGNITO_HOSTED_UI: HOSTED_UI,
    NEXT_PUBLIC_COGNITO_CLIENT_ID: CLIENT_ID,
    NEXT_PUBLIC_COGNITO_REDIRECT_URI: undefined,
    NEXT_PUBLIC_AWS_REGION: undefined,
    ...overrides,
  });
  vi.resetModules();
  return import("@/lib/auth/cognito-pkce");
}

/** The SHA-256 of a verifier, base64url — what `code_challenge` must be. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return base64Url(binary);
}

const savedLocation = window.location;

describe("cognito-pkce", () => {
  beforeEach(() => {
    installSessionStorage();
    installLocation();
    fetchMock.mockReset();
    assign.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: savedLocation,
    });
  });

  afterAll(() => env.restore());

  describe("configuration", () => {
    it("is unconfigured when either the hosted UI domain or the client id is missing", async () => {
      // Unconfigured must mean "render unauthenticated", the same contract HAS_OKTA_CONFIG and
      // HAS_ENTRA_CONFIG have — that is what keeps a laptop with no Cognito variables usable.
      expect((await loadPkce({ NEXT_PUBLIC_COGNITO_HOSTED_UI: undefined })).HAS_COGNITO_CONFIG).toBe(
        false,
      );
      expect((await loadPkce({ NEXT_PUBLIC_COGNITO_CLIENT_ID: undefined })).HAS_COGNITO_CONFIG).toBe(
        false,
      );
      expect((await loadPkce()).HAS_COGNITO_CONFIG).toBe(true);
    });

    it("accepts the hosted UI as a full domain, a URL, or a bare prefix", async () => {
      // Operators copy this value out of three different places in the console.
      expect((await loadPkce()).cognitoHostedUiOrigin()).toBe(`https://${HOSTED_UI}`);
      expect(
        (
          await loadPkce({ NEXT_PUBLIC_COGNITO_HOSTED_UI: `https://${HOSTED_UI}/` })
        ).cognitoHostedUiOrigin(),
      ).toBe(`https://${HOSTED_UI}`);
      expect(
        (
          await loadPkce({
            NEXT_PUBLIC_COGNITO_HOSTED_UI: "example-login",
            NEXT_PUBLIC_AWS_REGION: "eu-west-2",
          })
        ).cognitoHostedUiOrigin(),
      ).toBe("https://example-login.auth.eu-west-2.amazoncognito.com");
    });

    it("uses a custom domain as given", async () => {
      // A custom domain contains dots, so it is never mistaken for a prefix to expand.
      expect(
        (
          await loadPkce({ NEXT_PUBLIC_COGNITO_HOSTED_UI: "login.example.com" })
        ).cognitoHostedUiOrigin(),
      ).toBe("https://login.example.com");
    });

    it("defaults the redirect URI to this browser's origin + /callback", async () => {
      // The reason a deployment behind a generated *.cloudfront.net domain needs no rebuild.
      const { cognitoRedirectUri, COGNITO_REDIRECT_URI_IS_PINNED } = await loadPkce();
      expect(cognitoRedirectUri()).toBe(`${ORIGIN}/callback`);
      expect(COGNITO_REDIRECT_URI_IS_PINNED).toBe(false);
    });

    it("pins the redirect URI when one is configured", async () => {
      const { cognitoRedirectUri, COGNITO_REDIRECT_URI_IS_PINNED } = await loadPkce({
        // Trailing slash tolerated: operators paste URLs out of browsers.
        NEXT_PUBLIC_COGNITO_REDIRECT_URI: "https://recon.example.com/callback/",
      });
      expect(cognitoRedirectUri()).toBe("https://recon.example.com/callback");
      expect(COGNITO_REDIRECT_URI_IS_PINNED).toBe(true);
    });

    it.each([
      ["not absolute", "recon.example.com/callback"],
      ["not the callback path", "https://recon.example.com/recon/dashboard"],
      ["bare origin", "https://recon.example.com"],
    ])("rejects a pinned redirect URI that is %s", async (_label, value) => {
      // A typo here is otherwise invisible until Cognito answers `redirect_mismatch` and says nothing.
      const { cognitoRedirectUri } = await loadPkce({
        NEXT_PUBLIC_COGNITO_REDIRECT_URI: value,
      });
      expect(() => cognitoRedirectUri()).toThrow(/NEXT_PUBLIC_COGNITO_REDIRECT_URI/);
    });
  });

  describe("buildLoginUrl", () => {
    it("builds an S256 authorization-code request whose challenge matches the stored verifier", async () => {
      const pkce = await loadPkce();
      const url = new URL(await pkce.buildLoginUrl());

      expect(url.origin).toBe(`https://${HOSTED_UI}`);
      expect(url.pathname).toBe("/oauth2/authorize");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
      expect(url.searchParams.get("scope")).toBe("openid profile email");
      // S256, not `plain`: the verifier then travels only on the back-channel POST, so a captured
      // redirect (a proxy log, a referrer) yields a hash the captor cannot use.
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");

      const verifier = window.sessionStorage.getItem(pkce.COGNITO_KEYS.verifier) ?? "";
      // 32 random bytes, base64url — the length RFC 7636 recommends, and no padding or +/ characters.
      expect(verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
      expect(url.searchParams.get("code_challenge")).toBe(await s256(verifier));
    });

    it("generates a state parameter and stores it alongside the verifier", async () => {
      const pkce = await loadPkce();
      const url = new URL(await pkce.buildLoginUrl());
      const state = url.searchParams.get("state");
      expect(state).toMatch(/^[A-Za-z0-9\-_]{20,}$/);
      expect(window.sessionStorage.getItem(pkce.COGNITO_KEYS.state)).toBe(state);
    });

    it("uses a fresh verifier and state on every attempt", async () => {
      // Reuse would mean a second sign-in could be completed with a code captured from the first.
      const pkce = await loadPkce();
      const first = new URL(await pkce.buildLoginUrl());
      const second = new URL(await pkce.buildLoginUrl());
      expect(first.searchParams.get("code_challenge")).not.toBe(
        second.searchParams.get("code_challenge"),
      );
      expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    });

    it("records where to come back to, defaulting to the current page", async () => {
      const pkce = await loadPkce();
      await pkce.buildLoginUrl();
      expect(window.sessionStorage.getItem(pkce.COGNITO_KEYS.returnTo)).toBe(
        `${ORIGIN}/recon/dashboard`,
      );
      await pkce.buildLoginUrl(`${ORIGIN}/pipeline/inbox`);
      expect(window.sessionStorage.getItem(pkce.COGNITO_KEYS.returnTo)).toBe(
        `${ORIGIN}/pipeline/inbox`,
      );
    });
  });

  describe("exchangeCode", () => {
    it("posts the code and verifier, and stores the tokens it gets back", async () => {
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      const verifier = window.sessionStorage.getItem(pkce.COGNITO_KEYS.verifier);
      const tokens = {
        id_token: idTokenExpiringIn(3600),
        access_token: "access-1",
        refresh_token: "refresh-1",
      };
      fetchMock.mockResolvedValue(tokenResponse(tokens));

      expect(await pkce.exchangeCode("code-1", state)).toEqual(tokens);

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://${HOSTED_UI}/oauth2/token`);
      expect(init.method).toBe("POST");
      const body = new URLSearchParams(init.body as string);
      expect(Object.fromEntries(body)).toEqual({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: "code-1",
        redirect_uri: `${ORIGIN}/callback`,
        code_verifier: verifier,
      });
      // Stored, not merely returned: the predecessor of this module exchanged tokens and dropped
      // them, so the app signed in and then had no token to send.
      expect(pkce.readStoredTokens()).toEqual(tokens);
      expect(await pkce.currentIdToken()).toBe(tokens.id_token);
    });

    it("reads the state out of the URL when it is not passed in", async () => {
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      installLocation(`?code=code-1&state=${state}`, "/callback");
      fetchMock.mockResolvedValue(tokenResponse({ id_token: idTokenExpiringIn(3600) }));
      await expect(pkce.exchangeCode("code-1")).resolves.toMatchObject({
        id_token: expect.any(String),
      });
    });

    it("refuses a code whose state does not match this tab's request", async () => {
      // The CSRF case: a crafted /callback?code=... link. Nothing is exchanged, so the victim never
      // adopts the attacker's session.
      const pkce = await loadPkce();
      await pkce.buildLoginUrl();
      await expect(pkce.exchangeCode("attacker-code", "not-the-state")).rejects.toThrow(
        /state did not match/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a callback with no state at all", async () => {
      const pkce = await loadPkce();
      await pkce.buildLoginUrl();
      await expect(pkce.exchangeCode("code-1", null)).rejects.toThrow(/state did not match/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses a callback when this tab never started a sign-in", async () => {
      // Nothing in storage: a fresh tab opened straight onto the callback URL.
      const pkce = await loadPkce();
      await expect(pkce.exchangeCode("code-1", "some-state")).rejects.toThrow(
        /state did not match/i,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("consumes the state and verifier even when the attempt fails", async () => {
      // Otherwise a failed attempt leaves both reusable, which is exactly what replaying a code needs.
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      await expect(pkce.exchangeCode("code-1", "wrong")).rejects.toThrow();
      expect(window.sessionStorage.getItem(pkce.COGNITO_KEYS.state)).toBeNull();
      expect(window.sessionStorage.getItem(pkce.COGNITO_KEYS.verifier)).toBeNull();
      // And the once-correct state no longer works, even with a code never seen before — so this is
      // consumption, not the per-code idempotency below.
      await expect(pkce.exchangeCode("code-2", state)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("is idempotent per code, so a double-invoked effect does not burn the handshake", async () => {
      // React StrictMode runs effects twice in development, and any remount of the gate while
      // `?code=` is still in the URL has the same shape. A second real attempt would fail as "state
      // did not match" — which reads like an attack rather than a double call.
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      fetchMock.mockResolvedValue(tokenResponse({ id_token: idTokenExpiringIn(3600) }));

      const [first, second] = await Promise.all([
        pkce.exchangeCode("code-1", state),
        pkce.exchangeCode("code-1", state),
      ]);
      expect(second).toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // And sequentially, after the first has settled.
      await expect(pkce.exchangeCode("code-1", state)).resolves.toBe(first);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("surfaces the token endpoint's own error", async () => {
      // The status alone does not distinguish a reused code from a mismatched redirect URI.
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      fetchMock.mockResolvedValue(tokenError(400, "invalid_grant"));
      await expect(pkce.exchangeCode("code-1", state)).rejects.toThrow(/400.*invalid_grant/);
    });

    it("rejects a token response with no id_token", async () => {
      const pkce = await loadPkce();
      const state = new URL(await pkce.buildLoginUrl()).searchParams.get("state");
      fetchMock.mockResolvedValue(tokenResponse({ access_token: "a" }));
      await expect(pkce.exchangeCode("code-1", state)).rejects.toThrow(/no id_token/);
    });
  });

  describe("currentIdToken", () => {
    /** Put a token set in storage without going through the exchange. */
    async function seed(
      pkce: Pkce,
      tokens: Record<string, unknown>,
    ): Promise<void> {
      window.sessionStorage.setItem(pkce.COGNITO_KEYS.tokens, JSON.stringify(tokens));
    }

    it("returns a live token without touching the network", async () => {
      const pkce = await loadPkce();
      const token = idTokenExpiringIn(3600);
      await seed(pkce, { id_token: token, refresh_token: "refresh-1" });
      expect(await pkce.currentIdToken()).toBe(token);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns null when there is no session", async () => {
      const pkce = await loadPkce();
      expect(await pkce.currentIdToken()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      ["expired", -60],
      // Inside the skew: renewed BEFORE the server would reject it for clock drift.
      ["about to expire", 30],
    ])("refreshes a token that is %s", async (_label, seconds) => {
      const pkce = await loadPkce();
      await seed(pkce, { id_token: idTokenExpiringIn(seconds), refresh_token: "refresh-1" });
      const renewed = idTokenExpiringIn(3600);
      fetchMock.mockResolvedValue(tokenResponse({ id_token: renewed, access_token: "a2" }));

      expect(await pkce.currentIdToken()).toBe(renewed);
      const body = new URLSearchParams(
        (fetchMock.mock.calls[0][1] as RequestInit).body as string,
      );
      expect(Object.fromEntries(body)).toEqual({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: "refresh-1",
      });
    });

    it("keeps the refresh token a refresh response omits", async () => {
      // Cognito does not rotate refresh tokens, so overwriting the stored set naively would drop the
      // only credential that can renew — the session would die at the first ID-token expiry.
      const pkce = await loadPkce();
      await seed(pkce, { id_token: idTokenExpiringIn(-60), refresh_token: "refresh-1" });
      fetchMock.mockResolvedValue(tokenResponse({ id_token: idTokenExpiringIn(3600) }));
      await pkce.currentIdToken();
      expect(pkce.readStoredTokens()?.refresh_token).toBe("refresh-1");
    });

    it("drops the session when there is nothing to refresh with", async () => {
      // Keeping a dead ID token would 401 every call behind a UI that still looks signed in.
      const pkce = await loadPkce();
      await seed(pkce, { id_token: idTokenExpiringIn(-60) });
      expect(await pkce.currentIdToken()).toBeNull();
      expect(pkce.readStoredTokens()).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("drops the session when the pool refuses the refresh token", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const pkce = await loadPkce();
        await seed(pkce, { id_token: idTokenExpiringIn(-60), refresh_token: "stale" });
        fetchMock.mockResolvedValue(tokenError(400, "invalid_grant"));
        expect(await pkce.currentIdToken()).toBeNull();
        expect(pkce.readStoredTokens()).toBeNull();
      } finally {
        warn.mockRestore();
      }
    });

    it("treats an undecodable token as expired", async () => {
      const pkce = await loadPkce();
      await seed(pkce, { id_token: "not-a-jwt", refresh_token: "refresh-1" });
      const renewed = idTokenExpiringIn(3600);
      fetchMock.mockResolvedValue(tokenResponse({ id_token: renewed }));
      expect(await pkce.currentIdToken()).toBe(renewed);
    });

    it("shares one refresh between concurrent readers", async () => {
      // The shell and both apps can have several BFF calls in flight, each reading the token; N
      // simultaneous refreshes would be N round trips for one answer.
      const pkce = await loadPkce();
      await seed(pkce, { id_token: idTokenExpiringIn(-60), refresh_token: "refresh-1" });
      const renewed = idTokenExpiringIn(3600);
      fetchMock.mockResolvedValue(tokenResponse({ id_token: renewed }));

      const results = await Promise.all([
        pkce.currentIdToken(),
        pkce.currentIdToken(),
        pkce.currentIdToken(),
      ]);
      expect(results).toEqual([renewed, renewed, renewed]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("ignores a tokens key something else wrote", async () => {
      const pkce = await loadPkce();
      window.sessionStorage.setItem(pkce.COGNITO_KEYS.tokens, "not json");
      expect(pkce.readStoredTokens()).toBeNull();
      expect(await pkce.currentIdToken()).toBeNull();
    });
  });

  describe("logout", () => {
    it("ends the pool session at the hosted UI and comes back to this origin", async () => {
      const pkce = await loadPkce();
      const url = new URL(pkce.cognitoLogoutUrl());
      expect(url.origin).toBe(`https://${HOSTED_UI}`);
      expect(url.pathname).toBe("/logout");
      expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
      // Must be listed as an allowed sign-out URL on the app client; same value the Okta and Entra
      // sign-outs use as their post-logout URL.
      expect(url.searchParams.get("logout_uri")).toBe(ORIGIN);
    });

    it("clears this tab's tokens BEFORE navigating", async () => {
      // If the redirect is then refused (an unregistered sign-out URL), the app must come back
      // signed out rather than holding tokens that 401 behind a signed-in-looking UI.
      const pkce = await loadPkce();
      window.sessionStorage.setItem(
        pkce.COGNITO_KEYS.tokens,
        JSON.stringify({ id_token: idTokenExpiringIn(3600) }),
      );
      pkce.logout();
      expect(pkce.readStoredTokens()).toBeNull();
      expect(assign).toHaveBeenCalledWith(pkce.cognitoLogoutUrl());
    });

    it("throws rather than silently doing nothing when unconfigured", async () => {
      // `lib/shell/signOut.ts` relies on this: a sign-out control that quietly does nothing is the
      // failure it exists to surface, and both other providers' SDKs reject here too.
      const pkce = await loadPkce({ NEXT_PUBLIC_COGNITO_HOSTED_UI: undefined });
      expect(() => pkce.logout()).toThrow(/not configured/i);
      expect(assign).not.toHaveBeenCalled();
    });
  });

  describe("consumeReturnTo", () => {
    it("returns the recorded path once and then forgets it", async () => {
      const pkce = await loadPkce();
      await pkce.buildLoginUrl(`${ORIGIN}/pipeline/inbox?tab=new`);
      expect(pkce.consumeReturnTo()).toBe("/pipeline/inbox?tab=new");
      expect(pkce.consumeReturnTo()).toBe("/");
    });

    it("defaults to the console landing when nothing was recorded", async () => {
      expect((await loadPkce()).consumeReturnTo()).toBe("/");
    });

    it("refuses a cross-origin return address", async () => {
      // Read from this tab's own storage, but one stray setItem from being an open-redirect gadget —
      // and nothing about "come back where you were" needs another origin.
      const pkce = await loadPkce();
      window.sessionStorage.setItem(pkce.COGNITO_KEYS.returnTo, "https://evil.example/steal");
      expect(pkce.consumeReturnTo()).toBe("/");
    });

    it("refuses the callback path itself", async () => {
      // Returning there would re-run the callback with no code in the URL.
      const pkce = await loadPkce();
      window.sessionStorage.setItem(pkce.COGNITO_KEYS.returnTo, `${ORIGIN}/callback?code=x`);
      expect(pkce.consumeReturnTo()).toBe("/");
    });
  });

  describe("isLoginRedirect", () => {
    it.each([
      ["?code=abc&state=xyz", true],
      ["?error=access_denied&error_description=nope", true],
      ["", false],
      ["?tab=queue", false],
    ])("%s -> %s", async (search, expected) => {
      const pkce = await loadPkce();
      installLocation(search, "/callback");
      expect(pkce.isLoginRedirect()).toBe(expected);
    });
  });
});

/**
 * Recovery from an expired session.
 *
 * The defect these cover: with silent renew blocked by the CSP, an expired session left the app on
 * a spinner that never resolved. The fix redirects instead — so what has to hold is that a redirect
 * really is started, that it comes back to the page the user was on, and (the part that is easy to
 * get wrong) that a 401 nothing can fix stops rather than looping between app and provider forever.
 *
 * `NEXT_PUBLIC_AUTH_PROVIDER` is read at module load, so each case re-imports with the env set.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signInWithRedirect = vi.fn();
const loginRedirect = vi.fn();
const clear = vi.fn();

/** Mutable so a case can turn the configuration off without re-registering the mock. */
const oktaConfigModule = {
  HAS_OKTA_CONFIG: true,
  OKTA_REDIRECT_URI_IS_PINNED: true,
  oktaConfig: {
    issuer: "https://example.okta.com",
    clientId: "client-1",
    scopes: ["openid"],
    pkce: true,
  },
  oktaRedirectUri: () => "http://localhost:3000/login/callback",
  oktaTokenManagerOptions: { autoRenew: false, autoRemove: true },
};

const msalConfigModule = {
  HAS_ENTRA_CONFIG: true,
  msalConfig: { auth: { clientId: "c", authority: "https://login" } },
  tokenRequest: { scopes: ["openid"] },
  ENTRA_OBO_SCOPE: "",
};

vi.mock("@/lib/okta-config", () => oktaConfigModule);
vi.mock("@/lib/msal-config", () => msalConfigModule);

vi.mock("@okta/okta-auth-js", () => ({
  OktaAuth: class {
    signInWithRedirect = signInWithRedirect;
    tokenManager = { clear };
  },
}));

vi.mock("@azure/msal-browser", () => ({
  PublicClientApplication: class {
    loginRedirect = loginRedirect;
  },
}));

/**
 * Install a working in-memory sessionStorage.
 *
 * The shared test setup replaces it with a `vi.fn()` stub whose getItem always returns undefined,
 * which would make every loop-guard assertion here vacuously pass.
 */
function installRealSessionStorage(): void {
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
}

/** Load a fresh copy of reauth.ts bound to `provider`. */
async function loadReauth(provider: "okta" | "entra") {
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = provider;
  vi.resetModules();
  return import("@/lib/reauth");
}

describe("reauthenticate", () => {
  const savedProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  beforeEach(() => {
    signInWithRedirect.mockReset().mockResolvedValue(undefined);
    loginRedirect.mockReset().mockResolvedValue(undefined);
    clear.mockReset();
    oktaConfigModule.HAS_OKTA_CONFIG = true;
    msalConfigModule.HAS_ENTRA_CONFIG = true;
    // The loop guard lives in sessionStorage, and it is per-tab state that must not leak between
    // cases — a stale mark would silently make the next case's redirect "refused".
    installRealSessionStorage();
    // A cached instance survives resetModules (it lives on window), so drop it too.
    delete (window as unknown as { __okta_instance?: unknown }).__okta_instance;
    delete (window as unknown as { __msal_instance?: unknown }).__msal_instance;
  });

  afterEach(() => {
    if (savedProvider === undefined)
      delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    else process.env.NEXT_PUBLIC_AUTH_PROVIDER = savedProvider;
  });

  it("redirects to Okta and comes back to the current page", async () => {
    const { reauthenticate } = await loadReauth("okta");

    expect(await reauthenticate("expired")).toBe(true);
    expect(signInWithRedirect).toHaveBeenCalledWith({
      originalUri: window.location.href,
    });
  });

  it("drops the dead tokens before navigating away", async () => {
    // Otherwise a redirect that fails leaves the app holding a token that 401s every call while
    // the UI still looks signed in.
    const { reauthenticate } = await loadReauth("okta");

    await reauthenticate("expired");

    expect(clear).toHaveBeenCalled();
  });

  it("redirects to Entra when that is the configured provider", async () => {
    const { reauthenticate } = await loadReauth("entra");

    expect(await reauthenticate("expired")).toBe(true);
    expect(loginRedirect).toHaveBeenCalledWith({
      scopes: ["openid"],
      redirectStartPage: window.location.href,
    });
    expect(signInWithRedirect).not.toHaveBeenCalled();
  });

  it("refuses a second automatic attempt inside the guard window", async () => {
    // The loop that matters: a server rejecting every token would otherwise bounce the browser
    // between app and provider indefinitely, each round producing a fresh, equally rejected token.
    const { reauthenticate } = await loadReauth("okta");

    expect(await reauthenticate("unauthorized")).toBe(true);
    expect(await reauthenticate("unauthorized")).toBe(false);
    expect(signInWithRedirect).toHaveBeenCalledTimes(1);
  });

  it("lets a user-initiated attempt through the guard", async () => {
    // The "Sign in again" button must always do something, even right after a refused attempt.
    const { reauthenticate } = await loadReauth("okta");

    await reauthenticate("expired");
    expect(await reauthenticate("user")).toBe(true);
    expect(signInWithRedirect).toHaveBeenCalledTimes(2);
  });

  it("allows another automatic attempt once the guard window has passed", async () => {
    const { reauthenticate } = await loadReauth("okta");

    await reauthenticate("expired");
    // Guard window is 60s; move the clock past it rather than waiting.
    const later = Date.now() + 61_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await reauthenticate("expired")).toBe(true);
    expect(signInWithRedirect).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("refuses automatic re-auth when the guard mark is unreadable", async () => {
    // Comparing against NaN is always false, which would read as "allowed" — the opposite of safe.
    const { reauthenticate } = await loadReauth("okta");
    window.sessionStorage.setItem("recon.auth.lastAutomaticReauthAt", "soon");

    expect(await reauthenticate("expired")).toBe(false);
    expect(signInWithRedirect).not.toHaveBeenCalled();
  });

  it("reports failure rather than redirecting when no provider is configured", async () => {
    // Local dev and unconfigured builds: a 401 here is the server missing
    // ALLOW_ANONYMOUS_API, and there is nowhere to sign in.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    oktaConfigModule.HAS_OKTA_CONFIG = false;
    const { reauthenticate } = await loadReauth("okta");

    expect(await reauthenticate("unauthorized")).toBe(false);
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

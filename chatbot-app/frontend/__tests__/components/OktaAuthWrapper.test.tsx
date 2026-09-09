/**
 * The auth gate's failure behaviour.
 *
 * Reported defect: on a deployment where the credentials had expired, the app sat on
 * "Signing in with Okta..." indefinitely while the console showed a CSP framing violation (the
 * blocked silent-renew iframe) and two 401s from the BFF. Three separate things had to be true for
 * that screen to appear, and there is a test here for each:
 *
 *  1. children rendered before auth was known, which is what fired the 401s;
 *  2. a handshake that never settles left the spinner up with no explanation and no way out;
 *  3. a token expiring under a mounted app produced no reaction at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

const isLoginRedirect = vi.fn(() => false);
const handleLoginRedirect = vi.fn();
const isAuthenticated = vi.fn();
const signInWithRedirect = vi.fn();
const start = vi.fn();
const tokenManagerOn = vi.fn();
const tokenManagerOff = vi.fn();
const getTokensSync = vi.fn();
const setTokens = vi.fn();
const renewTokens = vi.fn();
const reauthenticate = vi.fn();

/** An hour of life left, expressed the way the SDK stores it: epoch SECONDS. */
function unexpiredTokens(extra: Record<string, unknown> = {}) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return { accessToken: { expiresAt }, idToken: { expiresAt }, ...extra };
}

vi.mock("@/lib/okta-config", () => ({
  HAS_OKTA_CONFIG: true,
  OKTA_REDIRECT_URI_IS_PINNED: true,
  oktaConfig: {
    issuer: "https://example.okta.com",
    clientId: "client-1",
    scopes: ["openid"],
    pkce: true,
  },
  oktaRedirectUri: () => "https://recon.example.com/login/callback",
  oktaTokenManagerOptions: { autoRenew: false, autoRemove: true },
}));

vi.mock("@/lib/reauth", () => ({
  reauthenticate: (...args: unknown[]) => reauthenticate(...args),
}));

vi.mock("@okta/okta-auth-js", () => ({
  OktaAuth: class {
    isLoginRedirect = isLoginRedirect;
    handleLoginRedirect = handleLoginRedirect;
    isAuthenticated = isAuthenticated;
    signInWithRedirect = signInWithRedirect;
    start = start;
    tokenManager = {
      on: tokenManagerOn,
      off: tokenManagerOff,
      getTokensSync,
      setTokens,
    };
    token = { renewTokens };
  },
}));

import OktaAuthWrapper from "@/components/OktaAuthWrapper";

/** The wrapper skips auth entirely on localhost, and jsdom serves the suite from there. */
function pretendDeployedHost(): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname: "recon.example.com",
      origin: "https://recon.example.com",
      href: "https://recon.example.com/recon/config",
    },
  });
}

const PROTECTED_TEXT = "case queue";

describe("OktaAuthWrapper", () => {
  const savedLocation = window.location;

  beforeEach(() => {
    isLoginRedirect.mockReset().mockReturnValue(false);
    handleLoginRedirect.mockReset().mockResolvedValue(undefined);
    isAuthenticated.mockReset().mockResolvedValue(true);
    signInWithRedirect.mockReset().mockResolvedValue(undefined);
    start.mockReset().mockResolvedValue(undefined);
    tokenManagerOn.mockReset();
    tokenManagerOff.mockReset();
    // No refresh token by default: that is the state of any deployment whose Okta authorization
    // server does not grant `offline_access`, and the fallback behaviour is what most of these
    // tests are about.
    getTokensSync.mockReset().mockReturnValue(unexpiredTokens());
    setTokens.mockReset();
    renewTokens.mockReset();
    reauthenticate.mockReset().mockResolvedValue(true);
    delete (window as unknown as { __okta_instance?: unknown }).__okta_instance;
    pretendDeployedHost();
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: savedLocation,
    });
    vi.useRealTimers();
  });

  it("does not render children until the session is confirmed", async () => {
    // The 401s in the report came from here: children used to render on the first pass, so their
    // effects fetched with whatever stale token was in storage before auth had been checked.
    let resolveAuth: (value: boolean) => void = () => {};
    isAuthenticated.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveAuth = resolve;
      }),
    );

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );

    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
    expect(screen.getByText(/signing in with okta/i)).toBeTruthy();

    resolveAuth(true);
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
  });

  it("redirects to sign-in with the current page as the return address", async () => {
    isAuthenticated.mockResolvedValue(false);

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );

    await waitFor(() =>
      expect(signInWithRedirect).toHaveBeenCalledWith({
        originalUri: "https://recon.example.com/recon/config",
      }),
    );
    // Still waiting, not showing the app, while the browser navigates away.
    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
  });

  it("explains itself instead of spinning forever when the handshake never settles", async () => {
    // The blocked silent-renew iframe made isAuthenticated() hang for two minutes per token. Any
    // future hang has the same shape, so the guard is on the symptom rather than that one cause.
    vi.useFakeTimers();
    isAuthenticated.mockReturnValue(new Promise<boolean>(() => {}));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );

    expect(screen.getByText(/signing in with okta/i)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(screen.getByText(/could not sign in with okta/i)).toBeTruthy();
    expect(screen.getByText(/did not respond within 20 seconds/i)).toBeTruthy();
    // And a way out, so the user is never left with reload-and-hope as the only option.
    expect(screen.getByRole("button", { name: /sign in again/i })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("names the redirect URI on failure", async () => {
    // Kept from the earlier P0: a rejected redirect URI is the likeliest cause, and printing it
    // turns an investigation into a copy-paste.
    isAuthenticated.mockRejectedValue(new Error("bad redirect uri"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );

    await waitFor(() =>
      expect(screen.getByText(/could not sign in with okta/i)).toBeTruthy(),
    );
    expect(
      screen.getByText("https://recon.example.com/login/callback"),
    ).toBeTruthy();
    consoleError.mockRestore();
  });

  it("arms the SDK's expiry timers once the session is confirmed", async () => {
    // `oktaAuth.start()` is the only thing that sets them up. Without it the token manager never
    // emits `expired`, so every listener below is dead code and `autoRemove` never drops a dead
    // token — the app's sole notice of an expired session was a 401 from the BFF.
    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(start).toHaveBeenCalled();
  });

  it("renews the session ahead of expiry instead of redirecting", async () => {
    // Expiry inside the renewal lead window, so the scheduled renewal is due right away.
    const expiresAt = Math.floor(Date.now() / 1000) + 30;
    getTokensSync.mockReturnValue({
      accessToken: { expiresAt },
      idToken: { expiresAt },
      refreshToken: { refreshToken: "r-1" },
    });
    const renewed = unexpiredTokens({ refreshToken: { refreshToken: "r-2" } });
    renewTokens.mockImplementation(async () => {
      // The renewal has to actually move the expiry, or the scheduler refuses to arm another one.
      getTokensSync.mockReturnValue(renewed);
      return renewed;
    });
    vi.useFakeTimers();

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );
    // Two steps: the first lets the sign-in handshake settle so `authed` flips and the effect that
    // installs the renewal actually runs; only then does the renewal timer exist to advance onto.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });

    expect(renewTokens).toHaveBeenCalled();
    // renewTokens() hands the tokens back without storing them; skipping this would leave the app
    // holding the ones that were about to expire while believing it had renewed.
    expect(setTokens).toHaveBeenCalledWith(renewed);
    // The whole point: no navigation, and the app never came down.
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(signInWithRedirect).not.toHaveBeenCalled();
    expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy();
  });

  it("renews rather than signs out when the expiry event beats the timer", async () => {
    // A tab asleep through its own renewal timer wakes to an already-expired token. The backstop
    // tries the same POST once, and succeeding must not cost the user a page load.
    getTokensSync.mockReturnValue(
      unexpiredTokens({ refreshToken: { refreshToken: "r-1" } }),
    );
    renewTokens.mockResolvedValue(unexpiredTokens());
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());

    const expiredHandler = tokenManagerOn.mock.calls.find(
      (call) => call[0] === "expired",
    )?.[1] as (key: string) => void;
    await act(async () => expiredHandler("idToken"));

    expect(setTokens).toHaveBeenCalled();
    expect(reauthenticate).not.toHaveBeenCalled();
    expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy();
    consoleWarn.mockRestore();
  });

  it("re-authenticates when a token expires under a mounted app", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());

    const expiredHandler = tokenManagerOn.mock.calls.find(
      (call) => call[0] === "expired",
    )?.[1] as (key: string) => void;
    expect(expiredHandler).toBeTypeOf("function");

    // The SDK fires this from a timer, outside React's knowledge — act() stands in for that.
    await act(async () => expiredHandler("idToken"));

    expect(reauthenticate).toHaveBeenCalledWith("expired");
    // Children unmount immediately, which stops any polling from firing a burst of 401s straight
    // through the redirect.
    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
    consoleWarn.mockRestore();
  });

  it("surfaces an error when the expiry redirect is refused", async () => {
    // A refused redirect that left the spinner up would recreate the reported bug exactly.
    reauthenticate.mockResolvedValue(false);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <OktaAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </OktaAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());

    const expiredHandler = tokenManagerOn.mock.calls.find(
      (call) => call[0] === "expired",
    )?.[1] as (key: string) => void;
    await act(async () => expiredHandler("idToken"));

    expect(screen.getByText(/your session expired/i)).toBeTruthy();
    expect(screen.queryByText(/signing in with okta/i)).toBeNull();
    consoleWarn.mockRestore();
  });
});

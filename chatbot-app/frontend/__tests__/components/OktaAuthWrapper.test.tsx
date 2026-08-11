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
const tokenManagerOn = vi.fn();
const tokenManagerOff = vi.fn();
const reauthenticate = vi.fn();

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
    tokenManager = { on: tokenManagerOn, off: tokenManagerOff };
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
    tokenManagerOn.mockReset();
    tokenManagerOff.mockReset();
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

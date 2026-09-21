/**
 * The Cognito auth gate, the default provider's front door.
 *
 * The properties are the ones the Okta wrapper had to learn the hard way (see its test file):
 *
 *  1. children never render before auth is known — that is where spurious 401s and a flash of
 *     protected UI to a signed-out user come from;
 *  2. a handshake that never settles reaches a state that EXPLAINS itself, with a way out, rather
 *     than a spinner that sits there;
 *  3. a hosted UI refusal (`?error=`) is shown, not swallowed;
 *  4. an unconfigured build and a laptop render the app unauthenticated, so neither needs a user pool.
 *
 * Plus the one that is specific to writing the flow by hand: the code exchange happens HERE, in the
 * gate, because this component renders in front of every page — including `/callback`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";

// Built inside vi.hoisted because the component imports cognito-pkce STATICALLY: the mock factory
// then runs before this file's own top-level consts would exist.
const { pkceModule, fns } = vi.hoisted(() => {
  const fns = {
    buildLoginUrl: vi.fn(),
    exchangeCode: vi.fn(),
    currentIdToken: vi.fn(),
    decodeJwtClaims: vi.fn(),
    logout: vi.fn(),
    reauthenticate: vi.fn(),
  };
  return {
    fns,
    /** Mutable so a case can turn the configuration off without re-registering the mock. */
    pkceModule: {
      HAS_COGNITO_CONFIG: true,
      COGNITO_REDIRECT_URI_IS_PINNED: true,
      COGNITO_CALLBACK_PATH: "/callback",
      cognitoRedirectUri: () => "https://console.example.com/callback",
      // Implemented rather than stubbed: the wrapper decides whether to complete a redirect BEFORE
      // its localhost pass-through, so this predicate is the thing under test in the two local-dev
      // callback cases below. It is the real one, verbatim.
      isLoginRedirect: () => {
        const params = new URLSearchParams(window.location.search ?? "");
        return params.has("code") || params.has("error");
      },
      buildLoginUrl: fns.buildLoginUrl,
      exchangeCode: fns.exchangeCode,
      currentIdToken: fns.currentIdToken,
      decodeJwtClaims: fns.decodeJwtClaims,
      logout: fns.logout,
    },
  };
});

const { buildLoginUrl, exchangeCode, currentIdToken, decodeJwtClaims, logout, reauthenticate } =
  fns;

vi.mock("@/lib/auth/cognito-pkce", () => pkceModule);
vi.mock("@/lib/reauth", () => ({ reauthenticate: fns.reauthenticate }));

import CognitoAuthWrapper, {
  cognitoSignOut,
  cognitoUserName,
} from "@/components/CognitoAuthWrapper";

const assign = vi.fn();

/** The wrapper skips auth entirely on localhost, and jsdom serves the suite from there. */
function pretendDeployedHost(search = ""): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname: "console.example.com",
      origin: "https://console.example.com",
      pathname: "/recon/config",
      search,
      href: `https://console.example.com/recon/config${search}`,
      assign,
    },
  });
}

/**
 * A laptop running `npm run dev`, optionally sitting on the hosted UI's callback.
 *
 * jsdom's own hostname is already localhost, but its `location` is not writable per-case, so the
 * local-dev cases install their own with the search string they need.
 */
function pretendLocalhost(search = ""): void {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      hostname: "localhost",
      origin: "http://localhost:3000",
      pathname: search ? "/callback" : "/recon/config",
      search,
      href: `http://localhost:3000${search ? "/callback" : "/recon/config"}${search}`,
      assign,
    },
  });
}

const PROTECTED_TEXT = "case queue";

describe("CognitoAuthWrapper", () => {
  const savedLocation = window.location;

  beforeEach(() => {
    pkceModule.HAS_COGNITO_CONFIG = true;
    pkceModule.COGNITO_REDIRECT_URI_IS_PINNED = true;
    buildLoginUrl
      .mockReset()
      .mockResolvedValue("https://example-login.auth.us-east-1.amazoncognito.com/oauth2/authorize?x=1");
    exchangeCode.mockReset().mockResolvedValue({ id_token: "id-1" });
    currentIdToken.mockReset().mockResolvedValue("id-1");
    decodeJwtClaims.mockReset().mockReturnValue({});
    logout.mockReset();
    reauthenticate.mockReset().mockResolvedValue(true);
    assign.mockReset();
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
    let resolveToken: (value: string | null) => void = () => {};
    currentIdToken.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveToken = resolve;
      }),
    );

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
    expect(screen.getByText(/signing in/i)).toBeTruthy();

    resolveToken("id-1");
    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
  });

  it("sends an unauthenticated visitor to the hosted UI, with this page as the return address", async () => {
    currentIdToken.mockResolvedValue(null);

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() =>
      expect(buildLoginUrl).toHaveBeenCalledWith(
        "https://console.example.com/recon/config",
      ),
    );
    expect(assign).toHaveBeenCalledWith(await buildLoginUrl.mock.results[0].value);
    // Still waiting, not showing the app, while the browser navigates away.
    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
  });

  it("exchanges the code on the callback rather than bouncing back to /authorize", async () => {
    // The gate renders in front of `/callback` too, so if it did not do the exchange itself it would
    // see "no session" and redirect — forever.
    pretendDeployedHost("?code=abc123&state=st-1");

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(exchangeCode).toHaveBeenCalledWith("abc123", "st-1");
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a state mismatch instead of adopting the session", async () => {
    // The CSRF case, surfaced: exchangeCode refuses, and the user sees why rather than a spinner.
    pretendDeployedHost("?code=attacker&state=wrong");
    exchangeCode.mockRejectedValue(
      new Error("Cognito sign-in state did not match this tab's request."),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    expect(screen.getByText(/state did not match/i)).toBeTruthy();
    expect(screen.queryByText(PROTECTED_TEXT)).toBeNull();
    expect(screen.getByRole("button", { name: /sign in again/i })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("reports a refusal from the hosted UI and does not try to exchange anything", async () => {
    // An unconfirmed account, a disabled user, a federation failure: Cognito redirects back with
    // `?error=`, and `error_description` is the sentence worth showing.
    pretendDeployedHost("?error=access_denied&error_description=User+is+disabled");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    expect(screen.getByText(/access_denied: User is disabled/)).toBeTruthy();
    expect(exchangeCode).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("explains itself instead of spinning forever when the handshake never settles", async () => {
    vi.useFakeTimers();
    currentIdToken.mockReturnValue(new Promise<string | null>(() => {}));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    expect(screen.getByText(/signing in/i)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(screen.getByText(/could not sign in/i)).toBeTruthy();
    expect(screen.getByText(/did not respond within 20 seconds/i)).toBeTruthy();
    // And a way out, so the user is never left with reload-and-hope as the only option.
    expect(screen.getByRole("button", { name: /sign in again/i })).toBeTruthy();
    consoleError.mockRestore();
  });

  it("names the callback URL on failure", async () => {
    // A callback URL missing from the app client's allowed list is the likeliest cause, and printing
    // it turns an investigation into a copy-paste.
    currentIdToken.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    expect(screen.getByText("https://console.example.com/callback")).toBeTruthy();
    consoleError.mockRestore();
  });

  it("suggests pinning the callback URL only when it is not already pinned", async () => {
    pkceModule.COGNITO_REDIRECT_URI_IS_PINNED = false;
    currentIdToken.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    expect(screen.getByText(/NEXT_PUBLIC_COGNITO_REDIRECT_URI/)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("re-authenticates when the user asks to sign in again", async () => {
    currentIdToken.mockRejectedValue(new Error("boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());

    await act(async () => {
      screen.getByRole("button", { name: /sign in again/i }).click();
    });
    // Through the shared redirect, not a second copy of the flow.
    expect(reauthenticate).toHaveBeenCalledWith("user");
    consoleError.mockRestore();
  });

  it("says so when there is nowhere to sign in", async () => {
    // reauthenticate() returning false means no configured provider; sitting on a spinner after that
    // is the bug `lib/reauth.ts` exists to prevent.
    currentIdToken.mockRejectedValue(new Error("boom"));
    reauthenticate.mockResolvedValue(false);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );
    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    await act(async () => {
      screen.getByRole("button", { name: /sign in again/i }).click();
    });

    expect(screen.getByText(/no Cognito hosted UI domain or client id/i)).toBeTruthy();
    consoleError.mockRestore();
  });

  it("renders the app unauthenticated when this build has no Cognito configuration", async () => {
    // Parity with the Okta and Entra wrappers: an unconfigured build must still render.
    pkceModule.HAS_COGNITO_CONFIG = false;

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(buildLoginUrl).not.toHaveBeenCalled();
    expect(currentIdToken).not.toHaveBeenCalled();
  });

  it("renders the app unauthenticated on localhost", async () => {
    // jsdom's own hostname is localhost, so restoring the real location is the local-dev case.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: savedLocation,
    });

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(buildLoginUrl).not.toHaveBeenCalled();
  });

  it("completes a hosted UI redirect on localhost, so a laptop can hold a real token", async () => {
    // ⚠️ The pass-through above must NOT swallow a callback. The documented local workflow is
    // `npm run dev` against a real deployment with anonymous mode off: the first BFF call 401s, the
    // backstop in lib/reauth.ts starts the hosted-UI redirect, and the pool sends the browser back to
    // http://localhost:3000/callback?code=... — a URL the deployment registers on the app client for
    // exactly this (cognito_local_dev_callbacks). Returning before the exchange dropped the code, so
    // the token was never obtained and the next call 401'd again, on a 60-second loop.
    pretendLocalhost("?code=abc123&state=st-1");

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(exchangeCode).toHaveBeenCalledWith("abc123", "st-1");
    // ...and still no redirect started from the gate itself.
    expect(assign).not.toHaveBeenCalled();
  });

  it("renders the app on localhost even when the callback produced no session", async () => {
    // The other half: a laptop must never be sent to the hosted UI BY THE GATE, or `npm run dev`
    // bounces through sign-in on every load and anonymous mode stops being usable at all.
    pretendLocalhost("?code=abc123&state=st-1");
    currentIdToken.mockResolvedValue(null);

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(PROTECTED_TEXT)).toBeTruthy());
    expect(buildLoginUrl).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("shows a hosted UI refusal on localhost rather than rendering as if nothing happened", async () => {
    pretendLocalhost("?error=access_denied&error_description=User+is+disabled");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <CognitoAuthWrapper>
        <p>{PROTECTED_TEXT}</p>
      </CognitoAuthWrapper>,
    );

    await waitFor(() => expect(screen.getByText(/could not sign in/i)).toBeTruthy());
    expect(screen.getByText(/access_denied: User is disabled/)).toBeTruthy();
    expect(exchangeCode).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("cognitoSignOut", () => {
  it("ends the session through the hosted UI", async () => {
    logout.mockReset();
    await cognitoSignOut();
    expect(logout).toHaveBeenCalled();
  });

  it("rejects when there is nothing to sign out of, rather than doing nothing", async () => {
    // `lib/shell/signOut.ts` turns this rejection into a message next to the control.
    logout.mockReset().mockImplementation(() => {
      throw new Error("Cognito is not configured in this build");
    });
    await expect(cognitoSignOut()).rejects.toThrow(/not configured/);
  });
});

describe("cognitoUserName", () => {
  beforeEach(() => {
    currentIdToken.mockReset().mockResolvedValue("id-1");
    decodeJwtClaims.mockReset();
  });

  it.each([
    [{ name: "A. Analyst", email: "a@example.com" }, "A. Analyst"],
    [{ email: "a@example.com" }, "a@example.com"],
    [{ preferred_username: "analyst" }, "analyst"],
    [{ "cognito:username": "pool-user-1" }, "pool-user-1"],
  ])("prefers the most human claim available", async (claims, expected) => {
    decodeJwtClaims.mockReturnValue(claims);
    expect(await cognitoUserName()).toBe(expected);
  });

  it("is null when there is no session or no usable claim", async () => {
    decodeJwtClaims.mockReturnValue({ sub: "uuid-only" });
    expect(await cognitoUserName()).toBeNull();
    currentIdToken.mockResolvedValue(null);
    expect(await cognitoUserName()).toBeNull();
  });
});

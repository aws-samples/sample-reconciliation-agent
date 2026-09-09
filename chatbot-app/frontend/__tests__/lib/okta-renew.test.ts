/**
 * Silent renewal, and the one thing it must never do.
 *
 * `@okta/okta-auth-js` renews two ways and chooses by whether a refresh token is in storage: a POST
 * to /token, or a hidden iframe on /authorize. The iframe is unusable in this deployment — the CSP
 * is `default-src 'self'` with no `frame-src`, so it never loads, no postMessage arrives, and the
 * SDK waits out a 120 s timeout. That is the reported "Signing in with Okta..." that never resolved.
 *
 * So the assertion that matters most below is a NEGATIVE one: with no refresh token, this module does
 * not call the SDK's renewal at all. Checking first is what makes the iframe unreachable, and it has
 * to hold because whether a refresh token exists depends on Okta-side policy (`offline_access` on the
 * authorization server's access-policy rule) that no build can verify.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OktaAuth } from "@okta/okta-auth-js";
import {
  hasRefreshToken,
  renewWithRefreshToken,
  startSilentRenew,
} from "@/lib/okta-renew";

const getTokensSync = vi.fn();
const setTokens = vi.fn();
const renewTokens = vi.fn();

/** Just enough of an OktaAuth to renew with. */
function fakeOktaAuth(): OktaAuth {
  return {
    tokenManager: { getTokensSync, setTokens },
    token: { renewTokens },
  } as unknown as OktaAuth;
}

/** Tokens `secondsLeft` from expiry, in the epoch SECONDS the SDK stores. */
function tokens({
  secondsLeft,
  withRefresh,
}: {
  secondsLeft: number;
  withRefresh: boolean;
}) {
  const expiresAt = Math.floor(Date.now() / 1000) + secondsLeft;
  return {
    accessToken: { expiresAt },
    idToken: { expiresAt },
    ...(withRefresh ? { refreshToken: { refreshToken: "r-1" } } : {}),
  };
}

describe("okta-renew", () => {
  beforeEach(() => {
    getTokensSync.mockReset();
    setTokens.mockReset();
    renewTokens.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports whether there is anything to renew with", () => {
    getTokensSync.mockReturnValue(
      tokens({ secondsLeft: 60, withRefresh: true }),
    );
    expect(hasRefreshToken(fakeOktaAuth())).toBe(true);
    getTokensSync.mockReturnValue(
      tokens({ secondsLeft: 60, withRefresh: false }),
    );
    expect(hasRefreshToken(fakeOktaAuth())).toBe(false);
  });

  it("renews with the refresh token and stores the result", async () => {
    getTokensSync.mockReturnValue(
      tokens({ secondsLeft: 60, withRefresh: true }),
    );
    const renewed = tokens({ secondsLeft: 3600, withRefresh: true });
    renewTokens.mockResolvedValue(renewed);

    expect(await renewWithRefreshToken(fakeOktaAuth())).toBe("renewed");
    // The SDK hands the tokens back rather than storing them. Without this the app would hold the
    // tokens that were about to expire while believing it had renewed.
    expect(setTokens).toHaveBeenCalledWith(renewed);
  });

  it("does not touch the SDK's renewal when there is no refresh token", async () => {
    getTokensSync.mockReturnValue(
      tokens({ secondsLeft: 60, withRefresh: false }),
    );
    expect(await renewWithRefreshToken(fakeOktaAuth())).toBe(
      "no-refresh-token",
    );
    // The reason this whole module exists: calling renewTokens() here would fall through to the
    // CSP-blocked iframe and hang for two minutes.
    expect(renewTokens).not.toHaveBeenCalled();
    expect(setTokens).not.toHaveBeenCalled();
  });

  it("distinguishes a refused renewal from a missing refresh token", async () => {
    // Different outcomes on purpose: one says change the Okta policy, the other says the provider
    // rejected a request it understood. Collapsing them would send an operator to the wrong place.
    getTokensSync.mockReturnValue(
      tokens({ secondsLeft: 60, withRefresh: true }),
    );
    renewTokens.mockRejectedValue(new Error("invalid_grant"));
    expect(await renewWithRefreshToken(fakeOktaAuth())).toBe("failed");
    expect(setTokens).not.toHaveBeenCalled();
  });

  describe("startSilentRenew", () => {
    /**
     * A token manager whose stored tokens actually change when they are renewed.
     *
     * `getTokensSync` returning a fixed object would be a lie that matters here: the schedule is
     * computed from the CURRENT expiry, so a mock that never advances makes the next delay collapse
     * to the floor and the renewal look like it fires in a loop.
     *
     * @param secondsLeft lifetime of the initial tokens.
     * @param grantsSecondsLeft lifetime each renewal returns.
     */
    function withRenewableTokens({
      secondsLeft,
      grantsSecondsLeft,
    }: {
      secondsLeft: number;
      grantsSecondsLeft: number;
    }): void {
      let current = tokens({ secondsLeft, withRefresh: true });
      getTokensSync.mockImplementation(() => current);
      renewTokens.mockImplementation(async () => {
        current = tokens({
          secondsLeft: grantsSecondsLeft,
          withRefresh: true,
        });
        return current;
      });
    }

    it("renews before expiry rather than after it", async () => {
      vi.useFakeTimers();
      // 10 minutes left, and the lead is 2, so nothing should happen for 8.
      withRenewableTokens({ secondsLeft: 600, grantsSecondsLeft: 3600 });
      const onUnrecoverable = vi.fn();

      const stop = startSilentRenew({
        oktaAuth: fakeOktaAuth(),
        onUnrecoverable,
      });

      await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
      expect(renewTokens).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(renewTokens).toHaveBeenCalledTimes(1);
      // A renewal is not a terminal state — the caller must not be told to sign in again.
      expect(onUnrecoverable).not.toHaveBeenCalled();
      stop();
    });

    it("keeps renewing, re-reading the expiry each time", async () => {
      vi.useFakeTimers();
      // Deliberately not a fixed interval: token lifetimes come from Okta policy and can change
      // under a running app, so the schedule has to follow the tokens rather than a constant. Three
      // minutes of life against a two-minute lead means one renewal a minute.
      withRenewableTokens({ secondsLeft: 180, grantsSecondsLeft: 180 });
      const stop = startSilentRenew({
        oktaAuth: fakeOktaAuth(),
        onUnrecoverable: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(renewTokens).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      expect(renewTokens).toHaveBeenCalledTimes(2);
      stop();
    });

    it("stops instead of spinning when a renewal does not extend the session", async () => {
      vi.useFakeTimers();
      // A provider that answers 200 with the same expiry. Without a guard the next delay collapses
      // to the one-second floor and the app renews once a second for as long as the tab is open.
      getTokensSync.mockReturnValue(
        tokens({ secondsLeft: 30, withRefresh: true }),
      );
      renewTokens.mockResolvedValue(
        tokens({ secondsLeft: 30, withRefresh: true }),
      );
      const onUnrecoverable = vi.fn();

      startSilentRenew({ oktaAuth: fakeOktaAuth(), onUnrecoverable });
      await vi.advanceTimersByTimeAsync(1_100);

      expect(renewTokens).toHaveBeenCalledTimes(1);
      expect(onUnrecoverable).toHaveBeenCalledWith(
        "renewing the session did not extend it",
      );
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(renewTokens).toHaveBeenCalledTimes(1);
    });

    it("hands back to the caller when the session cannot be renewed", async () => {
      vi.useFakeTimers();
      getTokensSync.mockReturnValue(
        tokens({ secondsLeft: 30, withRefresh: false }),
      );
      const onUnrecoverable = vi.fn();

      startSilentRenew({ oktaAuth: fakeOktaAuth(), onUnrecoverable });
      await vi.advanceTimersByTimeAsync(1_100);

      // Named, not silent: the caller's response is a top-level redirect, and an operator reading
      // the log needs to know it was the missing refresh token rather than a network failure.
      expect(onUnrecoverable).toHaveBeenCalledTimes(1);
      expect(onUnrecoverable.mock.calls[0][0]).toContain("refresh token");
    });

    it("gives up rather than looping when a renewal is refused", async () => {
      vi.useFakeTimers();
      getTokensSync.mockReturnValue(
        tokens({ secondsLeft: 30, withRefresh: true }),
      );
      renewTokens.mockRejectedValue(new Error("invalid_grant"));
      const onUnrecoverable = vi.fn();

      startSilentRenew({ oktaAuth: fakeOktaAuth(), onUnrecoverable });
      await vi.advanceTimersByTimeAsync(1_100);
      expect(onUnrecoverable).toHaveBeenCalledTimes(1);

      // No further attempt: a rotated-away or revoked refresh token fails identically every time,
      // and retrying on a one-second timer would hammer the provider until the tab closed.
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(renewTokens).toHaveBeenCalledTimes(1);
    });

    it("says so instead of scheduling against nothing when there are no tokens", () => {
      // Reached only if storage was cleared under the app. Scheduling off a null expiry would give
      // a timer that never fires, which is a silently dead session.
      getTokensSync.mockReturnValue({});
      const onUnrecoverable = vi.fn();
      startSilentRenew({ oktaAuth: fakeOktaAuth(), onUnrecoverable });
      expect(onUnrecoverable).toHaveBeenCalledWith(
        "there are no tokens to renew",
      );
    });

    it("cancels a pending renewal when stopped", async () => {
      vi.useFakeTimers();
      getTokensSync.mockReturnValue(
        tokens({ secondsLeft: 30, withRefresh: true }),
      );
      renewTokens.mockResolvedValue(
        tokens({ secondsLeft: 3600, withRefresh: true }),
      );
      const onUnrecoverable = vi.fn();

      const stop = startSilentRenew({
        oktaAuth: fakeOktaAuth(),
        onUnrecoverable,
      });
      stop();
      await vi.advanceTimersByTimeAsync(10 * 1000);

      // An unmounted wrapper must not keep renewing, and must never call back into React.
      expect(renewTokens).not.toHaveBeenCalled();
      expect(onUnrecoverable).not.toHaveBeenCalled();
    });
  });
});

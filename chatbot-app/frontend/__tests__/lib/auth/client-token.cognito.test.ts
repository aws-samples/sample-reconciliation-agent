/**
 * The shared ID-token reader on its Cognito branch — reached with `NEXT_PUBLIC_AUTH_PROVIDER` UNSET,
 * which is the point: the default provider and the default token reader must be the same one.
 *
 * Everything downstream (the shell's `/api/me`, `reconFetch`, `pipelineApi`, `consoleApi`) goes
 * through `authHeaders()`, so this is the only place the Cognito token has to be plumbed in. The
 * Entra/MSAL path has its own file next to this one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Unset, not "cognito": this file is also the check that the DEFAULT lands on this branch.
vi.hoisted(() => {
  delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
});

const currentIdToken = vi.fn();
/** Mutable so a case can turn the configuration off without re-registering the mock. */
const pkceModule = {
  HAS_COGNITO_CONFIG: true,
  currentIdToken: (...args: unknown[]) => currentIdToken(...args),
};

vi.mock("@/lib/auth/cognito-pkce", () => pkceModule);

const { authHeaders, idToken } = await import("@/lib/auth/client-token");

describe("client-token (cognito)", () => {
  beforeEach(() => {
    pkceModule.HAS_COGNITO_CONFIG = true;
    currentIdToken.mockReset().mockResolvedValue("pool-id-token-1");
  });

  it("reads the pool's ID token, refreshing it through cognito-pkce", async () => {
    // `currentIdToken` is where the refresh-on-read lives, so calling it (rather than reading storage
    // here) is what makes an aged-out token renew instead of 401ing.
    expect(await idToken()).toBe("pool-id-token-1");
    expect(currentIdToken).toHaveBeenCalledTimes(1);
  });

  it("returns a spreadable Authorization header", async () => {
    expect(await authHeaders()).toEqual({
      Authorization: "Bearer pool-id-token-1",
    });
  });

  it("returns no header when there is no session", async () => {
    currentIdToken.mockResolvedValue(null);
    expect(await idToken()).toBeNull();
    expect(await authHeaders()).toEqual({});
  });

  it("returns no header when this build has no Cognito configuration", async () => {
    // A laptop, or a deploy whose NEXT_PUBLIC_* args were not baked in. The server decides what an
    // unauthenticated call means; it only allows one under ALLOW_ANONYMOUS_API=true.
    pkceModule.HAS_COGNITO_CONFIG = false;
    expect(await idToken()).toBeNull();
    expect(currentIdToken).not.toHaveBeenCalled();
  });

  it("never throws, and logs under the neutral shell prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      currentIdToken.mockRejectedValue(new Error("sessionStorage unavailable"));
      expect(await idToken()).toBeNull();
      expect(await authHeaders()).toEqual({});
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[ClientToken\] /),
        expect.any(Error),
      );
      // The warning must not name an app: the shell calls this on consoles that run only one of them.
      for (const call of warn.mock.calls) {
        expect(String(call[0])).not.toMatch(/Pipeline|Recon/);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

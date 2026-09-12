/**
 * The one browser-side ID-token reader the shell and both apps share.
 *
 * Exercised through the Entra/MSAL path because that is the default provider
 * (NEXT_PUBLIC_AUTH_PROVIDER is unset in tests); the Okta branch is the same shape. The property
 * beyond the token itself is neutrality: a failure here is logged under the shell's own prefix, so a
 * recon-only console never sees a warning that blames an app it does not run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeMsal } from "../../helpers/msal";

const msal = fakeMsal();
const { account, acquireTokenSilent, getActiveAccount } = msal;
vi.mock("@/lib/msal-config", () => msal.configModule);
vi.mock("@azure/msal-browser", () => msal.browserModule);

// Loaded after the mocks are registered so the factories above never run before `msal` exists.
const { authHeaders, idToken } = await import("@/lib/auth/client-token");

describe("client-token", () => {
  beforeEach(() => {
    // The instance is cached on window across calls, so only the mocks need resetting.
    acquireTokenSilent.mockReset().mockResolvedValue({ idToken: "id-token-1" });
    getActiveAccount.mockReset().mockReturnValue(account);
  });

  it("reads the ID token (not the access token) from the signed-in account", async () => {
    acquireTokenSilent.mockResolvedValue({
      idToken: "id-token-1",
      accessToken: "access-token-1",
    });
    expect(await idToken()).toBe("id-token-1");
  });

  it("returns a spreadable Authorization header", async () => {
    expect(await authHeaders()).toEqual({ Authorization: "Bearer id-token-1" });
  });

  it("returns no header when nobody is signed in", async () => {
    getActiveAccount.mockReturnValue(undefined);
    // getAllAccounts() still returns the stub account, so drive the failure through acquisition.
    acquireTokenSilent.mockResolvedValue({ idToken: undefined });
    expect(await authHeaders()).toEqual({});
  });

  it("never throws when token acquisition fails, and logs under a neutral prefix", async () => {
    // A failed token read must surface as a 401 from the BFF, not as an unhandled rejection inside
    // whatever data fetch happened to trigger it. And the warning must not name an app: the shell
    // calls this for `/api/me` on consoles that run only one of them.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      acquireTokenSilent.mockRejectedValue(new Error("interaction_required"));
      expect(await idToken()).toBeNull();
      expect(await authHeaders()).toEqual({});
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^\[ClientToken\] /),
        expect.any(Error),
      );
      for (const call of warn.mock.calls) {
        expect(String(call[0])).not.toMatch(/Pipeline|Recon/);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

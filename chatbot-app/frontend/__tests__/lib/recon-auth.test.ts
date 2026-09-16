/**
 * Browser-side Authorization header for the recon BFF — the client half of its deny-by-default gate.
 *
 * Exercised through the Entra/MSAL path; the Okta and Cognito branches are the same shape. The
 * provider is now NAMED rather than implied: it used to be left unset because the default was Entra,
 * and the default is Cognito since 2026-09-16 (`lib/auth/provider.ts`). Nothing about the Entra path
 * changed — the assertions below are untouched — but this file has to say which path it is on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Before the imports below are evaluated: `lib/auth/provider.ts` reads the variable at module load.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_AUTH_PROVIDER = "entra";
});

const account = { homeAccountId: "acct-1" };
const acquireTokenSilent = vi.fn();
const getActiveAccount = vi.fn(() => account as unknown);

vi.mock("@/lib/msal-config", () => ({
  HAS_ENTRA_CONFIG: true,
  msalConfig: { auth: { clientId: "c", authority: "https://login" } },
  tokenRequest: { scopes: ["openid"] },
  ENTRA_OBO_SCOPE: "",
}));

vi.mock("@azure/msal-browser", () => ({
  PublicClientApplication: class {
    getActiveAccount = getActiveAccount;
    getAllAccounts = () => [account];
    acquireTokenSilent = acquireTokenSilent;
  },
}));

import * as shared from "@/lib/auth/client-token";
import { authHeaders, reconFetch, reconIdToken } from "@/lib/recon-auth";

describe("recon-auth", () => {
  beforeEach(() => {
    // The instance is cached on window across calls, so only the mocks need resetting.
    acquireTokenSilent.mockReset().mockResolvedValue({ idToken: "id-token-1" });
    getActiveAccount.mockReset().mockReturnValue(account);
  });

  it("is the shared token reader under an app-local name, not a second copy", () => {
    // The shell, recon and the pipeline present one ID token to one verifier; a per-app copy of the
    // Okta/MSAL reading code is how the shell ended up depending on the pipeline module.
    expect(reconIdToken).toBe(shared.idToken);
    expect(authHeaders).toBe(shared.authHeaders);
  });

  it("reads the ID token (not the access token) from the signed-in account", async () => {
    expect(await reconIdToken()).toBe("id-token-1");
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

  it("never throws when token acquisition fails", async () => {
    // A failed token read must surface as a 401 from the BFF, not as an unhandled rejection
    // inside whatever data fetch happened to trigger it.
    acquireTokenSilent.mockRejectedValue(new Error("interaction_required"));
    expect(await reconIdToken()).toBeNull();
    expect(await authHeaders()).toEqual({});
  });

  it("reconFetch attaches the header and preserves caller headers and init", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await reconFetch("/api/recon/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/recon/config", {
      method: "PUT",
      body: "{}",
      headers: {
        Authorization: "Bearer id-token-1",
        "Content-Type": "application/json",
      },
    });
  });

  it("reconFetch still sends the request when unauthenticated (the server decides)", async () => {
    acquireTokenSilent.mockResolvedValue({ idToken: undefined });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    vi.stubGlobal("fetch", fetchMock);

    await reconFetch("/api/recon/cases");

    expect(fetchMock).toHaveBeenCalledWith("/api/recon/cases", { headers: {} });
  });
});

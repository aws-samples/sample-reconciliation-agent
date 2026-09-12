/**
 * The one authenticated `fetch` behind every BFF client.
 *
 * Two contracts. The Authorization header is attached and the caller's own headers and init survive
 * the merge; and a 401 starts a re-authentication WITHOUT blocking the caller, who still gets the
 * response back. The token reader and the redirect are each tested where they live; here they are
 * mocked so the wrapper's own behaviour is what is pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authHeaders = vi.fn();
const reauthenticate = vi.fn();
vi.mock("@/lib/auth/client-token", () => ({
  authHeaders: (...a: unknown[]) => authHeaders(...a),
}));
vi.mock("@/lib/reauth", () => ({
  reauthenticate: (...a: unknown[]) => reauthenticate(...a),
}));

import { authedFetch } from "@/lib/auth/authed-fetch";

/** Let the un-awaited redirect promise and its `.catch` settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("authedFetch", () => {
  beforeEach(() => {
    authHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer id-token-1" });
    reauthenticate.mockReset().mockResolvedValue(true);
  });

  it("attaches the header and preserves caller headers and init", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await authedFetch("/api/recon/config", {
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
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("still sends the request when unauthenticated (the server decides)", async () => {
    authHeaders.mockResolvedValue({});
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await authedFetch("/api/pipeline/emails");

    expect(fetchMock).toHaveBeenCalledWith("/api/pipeline/emails", { headers: {} });
  });

  it("starts a re-authentication on a 401 and hands the response back without waiting", async () => {
    // The redirect never settles here, as it would not in a browser that is navigating away; the
    // caller must still get its response.
    reauthenticate.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const response = await authedFetch("/api/me");

    expect(response.status).toBe(401);
    expect(reauthenticate).toHaveBeenCalledWith("unauthorized");
  });

  it("does not re-authenticate on anything but a 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const response = await authedFetch("/api/console/settings");

    expect(response.status).toBe(403);
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("logs a failed redirect under the caller's label rather than throwing", async () => {
    reauthenticate.mockRejectedValue(new Error("popup blocked"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(authedFetch("/api/recon/cases", {}, "ReconAuth")).resolves.toMatchObject({
      status: 401,
    });
    await settle();

    expect(error).toHaveBeenCalledWith(
      "[ReconAuth] re-authentication failed:",
      expect.any(Error),
    );
    error.mockRestore();
  });
});

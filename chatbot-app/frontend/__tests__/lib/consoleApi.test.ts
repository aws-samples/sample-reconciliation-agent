/**
 * The console BFF client: one header, one error shape, five calls.
 *
 * What is pinned: every request carries the shared ID-token header (the console must present the same
 * token both apps do, through the same helper); a failure throws the server's own words when it gave
 * any and the status when it did not; a 401 starts the shared re-authentication and still surfaces;
 * and the two preference calls hand back only well-typed fields, whatever the row held.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authHeaders = vi.fn();
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: () => authHeaders() }));
const reauthenticate = vi.fn();
vi.mock("@/lib/reauth", () => ({ reauthenticate: (...a: unknown[]) => reauthenticate(...a) }));

import {
  accessCheck,
  getConsoleSettings,
  getPreferences,
  putPreferences,
  updateConsoleSettings,
} from "@/lib/consoleApi";

import { fakeResponse } from "../helpers/http";

function serve(status: number, body: unknown, opts: { raw?: boolean } = {}) {
  const fetchMock = vi.fn().mockResolvedValue(fakeResponse(status, body, opts));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  authHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer id-token-1" });
  reauthenticate.mockReset().mockResolvedValue(true);
});

describe("getConsoleSettings", () => {
  it("GETs the settings route with the shared token header and no caching", async () => {
    const fetchMock = serve(200, { configured: true });
    expect(await getConsoleSettings()).toEqual({ configured: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/console/settings",
      expect.objectContaining({ headers: { Authorization: "Bearer id-token-1" }, cache: "no-store" }),
    );
  });

  it("starts re-authentication on a 401 and still throws", async () => {
    serve(401, { error: "missing or malformed Authorization header" });
    await expect(getConsoleSettings()).rejects.toThrow("missing or malformed Authorization header");
    expect(reauthenticate).toHaveBeenCalledWith("unauthorized");
  });

  it("does not re-authenticate on a 403: the token is fine, the caller is not an admin", async () => {
    serve(403, { error: "console admins only" });
    await expect(getConsoleSettings()).rejects.toThrow("console admins only");
    expect(reauthenticate).not.toHaveBeenCalled();
  });
});

describe("updateConsoleSettings", () => {
  it("PUTs exactly the update given and returns the refreshed body", async () => {
    const refreshed = { configured: true, access: {} };
    const fetchMock = serve(200, refreshed);
    const update = { access: { recon: { accessGroup: "recon-analysts", adminGroup: "" } } };
    expect(await updateConsoleSettings(update)).toEqual(refreshed);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/console/settings");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ Authorization: "Bearer id-token-1", "Content-Type": "application/json" });
    // "" travels as "", because it is the instruction to clear a stored value.
    expect(JSON.parse(init.body as string)).toEqual(update);
  });
});

describe("accessCheck", () => {
  it("sends the groups comma-separated in the query, encoded", async () => {
    const fetchMock = serve(200, { groups: ["a b", "c/d"], apps: {}, consoleAdmin: false });
    await accessCheck(["a b", "c/d"]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/console/access-check?groups=a%20b%2Cc%2Fd");
  });

  it("asks about a user with no groups at all when the list is empty", async () => {
    const fetchMock = serve(200, { groups: [], apps: {}, consoleAdmin: false });
    await accessCheck([]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/console/access-check?groups=");
  });
});

describe("preferences", () => {
  it("GETs the row and keeps only well-typed fields", async () => {
    serve(200, { defaultApp: "recon", theme: "neon", railCollapsed: "yes", extra: 1 });
    expect(await getPreferences()).toEqual({ defaultApp: "recon" });
  });

  it("PUTs the whole row and returns what the server confirmed", async () => {
    const fetchMock = serve(200, { theme: "dark", railCollapsed: false });
    expect(await putPreferences({ theme: "dark", railCollapsed: false })).toEqual({
      theme: "dark",
      railCollapsed: false,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/console/preferences");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ theme: "dark", railCollapsed: false });
  });

  it("treats an empty 2xx as confirmation of what was sent", async () => {
    serve(204, undefined);
    expect(await putPreferences({ defaultApp: "pipeline" })).toEqual({ defaultApp: "pipeline" });
  });
});

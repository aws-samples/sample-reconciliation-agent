/**
 * The console viewer: the shell's one identity read.
 *
 * Four properties matter. The request must carry the same ID token the BFF verifies everywhere else
 * (through the console-level helper, not either app's); a failure must surface as a readable error (the
 * banner shows it) rather than as a silent "no apps", and a 401 must start the same re-authentication
 * the apps' fetch wrappers do; however many shell pieces mount, `/api/me` is asked ONCE per page load;
 * and because the frame stays mounted for the whole session, every mounted hook must see the result of
 * a request that a later mount or an explicit reload started — the cache is a store, not a snapshot.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authHeaders = vi.fn();
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: () => authHeaders() }));
const reauthenticate = vi.fn();
vi.mock("@/lib/reauth", () => ({ reauthenticate: (...a: unknown[]) => reauthenticate(...a) }));

import {
  DEFAULT_CONSOLE_FIELDS,
  fetchViewer,
  isShellHidden,
  loadViewer,
  normalizeViewer,
  reloadViewer,
  resetViewerCache,
  updateViewerPreferences,
  useViewer,
  type ConsoleViewer,
} from "@/lib/shell/viewer";

import { fakeResponse } from "../helpers/http";

/** A viewer as `/api/me` returns it, console fields included. */
function viewer(over: Partial<ConsoleViewer> = {}): ConsoleViewer {
  return {
    subject: "sub-1",
    groups: ["desk-users"],
    mode: "okta",
    apps: {
      recon: { access: true, admin: false },
      pipeline: { access: false, admin: false },
    },
    console: { ...DEFAULT_CONSOLE_FIELDS },
    preferences: {},
    ...over,
  };
}

beforeEach(() => {
  resetViewerCache();
  authHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer id-token-1" });
  reauthenticate.mockReset().mockResolvedValue(true);
});

describe("isShellHidden", () => {
  it.each([
    ["/login", true],
    ["/login/callback", true],
    ["/oauth-complete", true],
    ["/health", true],
    ["/embed", true],
    ["/embed/chat", true],
    ["/", false],
    ["/recon/dashboard", false],
    ["/pipeline/inbox", false],
    // A prefix match must not swallow unrelated routes that merely start with the same letters.
    ["/loginfoo", false],
    ["/healthcheck", false],
  ])("%s -> %s", (path, hidden) => {
    expect(isShellHidden(path)).toBe(hidden);
  });

  it("treats an unknown pathname as visible so the rail never flashes off", () => {
    expect(isShellHidden(null)).toBe(false);
    expect(isShellHidden(undefined)).toBe(false);
  });
});

describe("normalizeViewer", () => {
  it("passes a well-formed body through", () => {
    expect(normalizeViewer(viewer())).toEqual(viewer());
  });

  it("reads a missing app entry as no access, never as open", () => {
    const v = normalizeViewer({ subject: "s", groups: [], mode: "okta", apps: { recon: { access: true } } });
    expect(v.apps.recon).toEqual({ access: true, admin: false });
    expect(v.apps.pipeline).toEqual({ access: false, admin: false });
  });

  it("does not let a truthy non-boolean grant anything", () => {
    const v = normalizeViewer({ apps: { recon: { access: "yes", admin: 1 } } });
    expect(v.apps.recon).toEqual({ access: false, admin: false });
  });

  it("grants access to an admin even if the route forgot to", () => {
    const v = normalizeViewer({ apps: { pipeline: { access: false, admin: true } } });
    expect(v.apps.pipeline).toEqual({ access: true, admin: true });
  });

  it("tolerates garbage", () => {
    expect(normalizeViewer(null).subject).toBe("");
    expect(normalizeViewer({ groups: "admins" }).groups).toEqual([]);
    expect(normalizeViewer({ groups: ["a", 1, null] }).groups).toEqual(["a"]);
  });

  it("defaults the console fields when an older /api/me omits them", () => {
    // An image from before the configuration layer: the Settings screens must read as read-only and the
    // preferences as browser-only, not crash on a missing block.
    const { console: fields, preferences } = normalizeViewer({
      subject: "s",
      groups: [],
      mode: "okta",
      apps: {},
    });
    expect(fields).toEqual({ admin: false, configured: false, organizationLabel: "" });
    expect(preferences).toEqual({});
  });

  it("reads the console flags strictly and trims the label", () => {
    const v = normalizeViewer({
      console: { admin: "yes", configured: true, organizationLabel: "  Meridian Ops " },
    });
    // A truthy non-boolean must not make anyone a console admin.
    expect(v.console).toEqual({ admin: false, configured: true, organizationLabel: "Meridian Ops" });
    expect(normalizeViewer({ console: { admin: true } }).console.admin).toBe(true);
  });

  it("keeps only well-typed preferences", () => {
    const v = normalizeViewer({
      preferences: { defaultApp: "pipeline", railCollapsed: true, theme: "dark" },
    });
    expect(v.preferences).toEqual({ defaultApp: "pipeline", railCollapsed: true, theme: "dark" });

    // An unknown app would redirect `/` nowhere; an unknown theme would set an unstyled class; a string
    // "true" is not a boolean. Each is dropped rather than coerced.
    const junk = normalizeViewer({
      preferences: { defaultApp: "billing", railCollapsed: "true", theme: "neon" },
    });
    expect(junk.preferences).toEqual({});
  });
});

describe("updateViewerPreferences", () => {
  it("publishes a new viewer with the preferences replaced, to every subscriber", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(200, viewer())));
    const a = renderHook(() => useViewer());
    const b = renderHook(() => useViewer());
    await waitFor(() => expect(a.result.current.viewer).toEqual(viewer()));
    const before = a.result.current.viewer;

    act(() => updateViewerPreferences({ theme: "dark", railCollapsed: true }));
    expect(a.result.current.viewer?.preferences).toEqual({ theme: "dark", railCollapsed: true });
    expect(b.result.current.viewer?.preferences).toEqual({ theme: "dark", railCollapsed: true });
    // A new object: the shell applies a viewer's preferences once per object, so a changed preference
    // must arrive as one the shell has not seen.
    expect(a.result.current.viewer).not.toBe(before);
    expect(a.result.current.viewer?.subject).toBe("sub-1");
    // Replaced, not merged: a field absent from the new row is gone.
    act(() => updateViewerPreferences({ theme: "light" }));
    expect(a.result.current.viewer?.preferences).toEqual({ theme: "light" });
  });

  it("sanitises what it is handed and is a no-op while no viewer is known", () => {
    updateViewerPreferences({ theme: "dark" });
    const { result } = renderHook(() => useViewer());
    expect(result.current).toEqual({ viewer: null, loading: true, error: null });
  });
});

describe("fetchViewer", () => {
  it("GETs /api/me with the console-level ID-token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, viewer()));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchViewer()).toEqual(viewer());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({ headers: { Authorization: "Bearer id-token-1" } }),
    );
  });

  it("throws with the status and the server's reason on a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse(503, { error: "AUTH_PROVIDER is unset" }, { statusText: "Service Unavailable" })),
    );
    await expect(fetchViewer()).rejects.toThrow("GET /api/me failed (503): AUTH_PROVIDER is unset");
    // A 503 is a server problem; signing in again would not fix it, so no redirect is started.
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("still names the status when the failure body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        json: async () => {
          throw new SyntaxError("not json");
        },
      }),
    );
    await expect(fetchViewer()).rejects.toThrow("GET /api/me failed (502): Bad Gateway");
  });

  it("starts the automatic re-authentication on a 401 and still reports the failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse(401, { error: "missing or malformed Authorization header" })),
    );
    // `/api/me` is the only request the landing page makes, so without this an expired session on `/`
    // would sit on the error card forever while every app page re-authenticated itself.
    await expect(fetchViewer()).rejects.toThrow("GET /api/me failed (401)");
    expect(reauthenticate).toHaveBeenCalledWith("unauthorized");
  });

  it("does not let a refused or failed re-authentication mask the 401", async () => {
    reauthenticate.mockRejectedValue(new Error("provider unreachable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(401, { error: "expired" })));

    await expect(fetchViewer()).rejects.toThrow("GET /api/me failed (401): expired");
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    consoleError.mockRestore();
  });
});

describe("useViewer", () => {
  it("starts loading and resolves to the viewer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(200, viewer())));
    const { result } = renderHook(() => useViewer());
    expect(result.current).toEqual({ viewer: null, loading: true, error: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.viewer).toEqual(viewer());
    expect(result.current.error).toBeNull();
  });

  it("fetches once however many components mount it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, viewer()));
    vi.stubGlobal("fetch", fetchMock);

    const a = renderHook(() => useViewer());
    const b = renderHook(() => useViewer());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands a later mount the settled viewer on its first render", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, viewer()));
    vi.stubGlobal("fetch", fetchMock);
    const first = renderHook(() => useViewer());
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    // Client-side navigation to `/` mounts the landing page after the rail already knows the answer; it
    // must not flash a skeleton for a value that is already in hand, nor ask again.
    const second = renderHook(() => useViewer());
    expect(second.result.current).toEqual({ viewer: viewer(), loading: false, error: null });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failure as an error string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(fakeResponse(503, { error: "identity provider unreachable" }, { statusText: "Service Unavailable" })),
    );
    const { result } = renderHook(() => useViewer());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.viewer).toBeNull();
    expect(result.current.error).toContain("503");
    expect(result.current.error).toContain("identity provider unreachable");
  });

  it("lets a later mount retry after a failure, and the earlier mount sees the recovery too", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(503, { error: "identity provider unreachable" }, { statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(fakeResponse(200, viewer()));
    vi.stubGlobal("fetch", fetchMock);

    // The frame: mounted once for the whole session.
    const frame = renderHook(() => useViewer());
    await waitFor(() => expect(frame.result.current.loading).toBe(false));
    expect(frame.result.current.error).toContain("503");

    // The landing page: mounted later by a navigation. Its mount retries, and the frame — which
    // never remounts — must not stay on the stale failure while the page shows both app cards.
    const landing = renderHook(() => useViewer());
    await waitFor(() => expect(landing.result.current.viewer).toEqual(viewer()));
    expect(frame.result.current).toEqual({ viewer: viewer(), loading: false, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reloadViewer re-asks /api/me and moves every subscriber through loading to the new answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(200, viewer()))
      .mockResolvedValueOnce(fakeResponse(200, viewer({ subject: "sub-2" })));
    vi.stubGlobal("fetch", fetchMock);

    const a = renderHook(() => useViewer());
    const b = renderHook(() => useViewer());
    await waitFor(() => expect(a.result.current.viewer).toEqual(viewer()));

    let pending!: Promise<unknown>;
    act(() => {
      pending = reloadViewer();
    });
    // Nothing renders the old identity while the new one is on its way.
    expect(a.result.current).toEqual({ viewer: null, loading: true, error: null });
    expect(b.result.current).toEqual({ viewer: null, loading: true, error: null });

    await act(async () => {
      await pending;
    });
    expect(a.result.current.viewer?.subject).toBe("sub-2");
    expect(b.result.current.viewer?.subject).toBe("sub-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares one request between a reload and a load that overlap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, viewer()));
    vi.stubGlobal("fetch", fetchMock);

    const first = reloadViewer();
    expect(loadViewer()).toBe(first);
    expect(reloadViewer()).toBe(first);
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores the answer of a request that a reset superseded", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    const { result } = renderHook(() => useViewer());
    expect(result.current.loading).toBe(true);

    // The cache is forgotten while the request is still out; the late answer must not repopulate it.
    act(() => resetViewerCache());
    await act(async () => {
      resolve(fakeResponse(200, viewer()));
    });
    expect(result.current).toEqual({ viewer: null, loading: true, error: null });
  });
});

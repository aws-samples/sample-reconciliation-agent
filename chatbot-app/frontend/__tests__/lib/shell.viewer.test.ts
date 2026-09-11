/**
 * The console viewer: the shell's one identity read.
 *
 * Three properties matter. The request must carry the same ID token the BFF verifies everywhere else;
 * a failure must surface as a readable error (the banner shows it) rather than as a silent "no apps";
 * and however many shell pieces mount, `/api/me` is asked ONCE per page load, which is what the
 * module-scope promise is for.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "@/lib/auth/apps";

const authHeaders = vi.fn();
vi.mock("@/lib/pipeline-auth", () => ({ authHeaders: () => authHeaders() }));

import {
  fetchViewer,
  isShellHidden,
  normalizeViewer,
  resetViewerCache,
  useViewer,
} from "@/lib/shell/viewer";

/** A viewer as `/api/me` returns it. */
function viewer(over: Partial<Viewer> = {}): Viewer {
  return {
    subject: "sub-1",
    groups: ["desk-users"],
    mode: "okta",
    apps: {
      recon: { access: true, admin: false },
      pipeline: { access: false, admin: false },
    },
    ...over,
  };
}

/** A fetch stub in the shape the code reads (`ok`, `status`, `json`). */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? "Service Unavailable" : "",
    json: async () => body,
  };
}

beforeEach(() => {
  resetViewerCache();
  authHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer id-token-1" });
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
});

describe("fetchViewer", () => {
  it("GETs /api/me with the shared ID-token header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(viewer()));
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
      vi.fn().mockResolvedValue(jsonResponse({ error: "AUTH_PROVIDER is unset" }, 503)),
    );
    await expect(fetchViewer()).rejects.toThrow("GET /api/me failed (503): AUTH_PROVIDER is unset");
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
});

describe("useViewer", () => {
  it("starts loading and resolves to the viewer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(viewer())));
    const { result } = renderHook(() => useViewer());
    expect(result.current).toEqual({ viewer: null, loading: true, error: null });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.viewer).toEqual(viewer());
    expect(result.current.error).toBeNull();
  });

  it("fetches once however many components mount it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(viewer()));
    vi.stubGlobal("fetch", fetchMock);

    const a = renderHook(() => useViewer());
    const b = renderHook(() => useViewer());
    await waitFor(() => expect(a.result.current.loading).toBe(false));
    await waitFor(() => expect(b.result.current.loading).toBe(false));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hands a later mount the settled viewer on its first render", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(viewer())));
    const first = renderHook(() => useViewer());
    await waitFor(() => expect(first.result.current.loading).toBe(false));

    // Client-side navigation to `/` mounts the landing page after the rail already knows the answer; it
    // must not flash a skeleton for a value that is already in hand.
    const second = renderHook(() => useViewer());
    expect(second.result.current).toEqual({ viewer: viewer(), loading: false, error: null });
  });

  it("reports a failure as an error string and lets the next mount retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "identity provider unreachable" }, 503))
      .mockResolvedValueOnce(jsonResponse(viewer()));
    vi.stubGlobal("fetch", fetchMock);

    const failed = renderHook(() => useViewer());
    await waitFor(() => expect(failed.result.current.loading).toBe(false));
    expect(failed.result.current.viewer).toBeNull();
    expect(failed.result.current.error).toContain("503");
    expect(failed.result.current.error).toContain("identity provider unreachable");

    const retried = renderHook(() => useViewer());
    await waitFor(() => expect(retried.result.current.loading).toBe(false));
    expect(retried.result.current.viewer).toEqual(viewer());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

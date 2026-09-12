/**
 * The viewer hook behind every app's nav and tables, reading the shell's `/api/me`.
 *
 * Three properties matter. It must start as "unknown" (empty subject, not admin) so nothing writes a
 * shared preference key or shows an admin tab before the identity is known; it must fetch ONCE per page
 * load for an app however many components mount it, which is what the module-scope promise cache is
 * for; and `isAdmin` must come from THIS app's block of the body, not from another app's flag or from a
 * top-level field. The cache is module state, so each case re-imports the module.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const authedFetch = vi.fn();
vi.mock("@/lib/auth/authed-fetch", () => ({
  authedFetch: (...a: unknown[]) => authedFetch(...a),
}));

/** What `/api/me` answers for a viewer who administers recon but only uses the pipeline. */
const ME = {
  subject: "sub-1",
  groups: ["desk-admins"],
  mode: "okta",
  apps: {
    recon: { access: true, admin: true },
    pipeline: { access: true, admin: false },
  },
};

/** A `Response`-shaped answer. */
function answer(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 401, json: async () => body };
}

/** A fresh copy of the hook with an empty cache. */
async function loadHook() {
  vi.resetModules();
  return (await import("@/hooks/useAppSubject")).useAppSubject;
}

beforeEach(() => {
  authedFetch.mockReset();
});

describe("useAppSubject", () => {
  it("starts unknown and resolves to the viewer /api/me returns, admin read from this app's block", async () => {
    authedFetch.mockResolvedValue(answer(ME));
    const useAppSubject = await loadHook();

    const { result } = renderHook(() => useAppSubject("recon"));
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });

    await waitFor(() => expect(result.current.subject).toBe("sub-1"));
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.groups).toEqual(["desk-admins"]);
  });

  it("asks the shell's /api/me through the authenticated wrapper", async () => {
    authedFetch.mockResolvedValue(answer(ME));
    const useAppSubject = await loadHook();

    const { result } = renderHook(() => useAppSubject("recon"));
    await waitFor(() => expect(result.current.subject).toBe("sub-1"));

    expect(authedFetch).toHaveBeenCalledTimes(1);
    expect(authedFetch.mock.calls[0][0]).toBe("/api/me");
  });

  it("reads admin per app: one body says admin for recon and not for the pipeline", async () => {
    authedFetch.mockResolvedValue(answer(ME));
    const useAppSubject = await loadHook();

    const recon = renderHook(() => useAppSubject("recon"));
    const pipeline = renderHook(() => useAppSubject("pipeline"));
    await waitFor(() => expect(recon.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(pipeline.result.current.subject).toBe("sub-1"));

    expect(recon.result.current.isAdmin).toBe(true);
    expect(pipeline.result.current.isAdmin).toBe(false);
  });

  it("fetches once per app however many components mount it", async () => {
    authedFetch.mockResolvedValue(answer(ME));
    const useAppSubject = await loadHook();

    const a = renderHook(() => useAppSubject("pipeline"));
    const b = renderHook(() => useAppSubject("pipeline"));
    await waitFor(() => expect(a.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(b.result.current.subject).toBe("sub-1"));

    expect(authedFetch).toHaveBeenCalledTimes(1);
  });

  it("degrades to unknown when the route answers with an error status", async () => {
    authedFetch.mockResolvedValue(answer({ error: "unauthorized" }, false));
    const useAppSubject = await loadHook();

    const { result } = renderHook(() => useAppSubject("recon"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });
  });

  it("degrades to unknown when the request fails, rather than throwing into the nav", async () => {
    authedFetch.mockRejectedValue(new Error("network down"));
    const useAppSubject = await loadHook();

    const { result } = renderHook(() => useAppSubject("recon"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });
  });

  it("validates each field rather than trusting a partial body", async () => {
    // A body answering `admin: "yes"` must not make anyone an admin, a top-level `isAdmin` (the
    // per-app routes' field) must be ignored, and a missing subject must stay empty rather than
    // becoming "undefined".
    authedFetch.mockResolvedValue(
      answer({ isAdmin: true, groups: "admins", apps: { recon: { admin: "yes" } } }),
    );
    const useAppSubject = await loadHook();

    const { result } = renderHook(() => useAppSubject("recon"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });
  });
});

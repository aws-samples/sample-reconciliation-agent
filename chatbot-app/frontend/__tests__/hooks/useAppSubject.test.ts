/**
 * The viewer hook behind every app's nav and tables: a projection of the shell's viewer store.
 *
 * Three properties matter. It must read as "unknown" (empty subject, not admin) while the store is
 * loading and after a failure, so nothing writes a shared preference key or shows an admin tab before
 * the identity is known; it must not ask `/api/me` itself, nor retry it after a failure — the shell
 * frame that mounted the page asks ONCE per page load however many hooks mount, and the banner's Retry
 * is the only retrier (a hook that retried would remount under the frame's skeleton in a loop); and
 * `isAdmin` must come from THIS app's block of the body, not from another
 * app's flag or from a top-level field. The store is module state, so each case resets it.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeResponse } from "../helpers/http";

const authHeaders = vi.fn();
vi.mock("@/lib/auth/client-token", () => ({
  authHeaders: () => authHeaders(),
}));
const reauthenticate = vi.fn();
vi.mock("@/lib/reauth", () => ({
  reauthenticate: (...a: unknown[]) => reauthenticate(...a),
}));

import { useAppSubject } from "@/hooks/useAppSubject";
import { resetViewerCache, useViewer } from "@/lib/shell/viewer";

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

const UNKNOWN = { subject: "", groups: [], isAdmin: false };

/** Stub `fetch` with one answer and return the mock, so a case can count calls. */
function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(fakeResponse(status, body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Mount the store beside a case and wait for its request to settle, success or failure. */
async function settled() {
  const store = renderHook(() => useViewer());
  await waitFor(() => expect(store.result.current.loading).toBe(false));
  return store;
}

beforeEach(() => {
  resetViewerCache();
  authHeaders
    .mockReset()
    .mockResolvedValue({ Authorization: "Bearer id-token-1" });
  reauthenticate.mockReset().mockResolvedValue(true);
});

describe("useAppSubject", () => {
  it("starts unknown and resolves to the viewer /api/me returns, admin read from this app's block", async () => {
    serve(ME);

    const { result } = renderHook(() => useAppSubject("recon"));
    expect(result.current).toEqual(UNKNOWN);
    // The frame, not the hook, starts the read.
    renderHook(() => useViewer());

    await waitFor(() => expect(result.current.subject).toBe("sub-1"));
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.groups).toEqual(["desk-admins"]);
  });

  it("is a projection of the shell's store: one /api/me request for the rail and both apps together", async () => {
    const fetchMock = serve(ME);

    const shell = renderHook(() => useViewer());
    const recon = renderHook(() => useAppSubject("recon"));
    const pipeline = renderHook(() => useAppSubject("pipeline"));
    const table = renderHook(() => useAppSubject("pipeline"));
    await waitFor(() => expect(shell.result.current.loading).toBe(false));
    await waitFor(() => expect(recon.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(pipeline.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(table.result.current.subject).toBe("sub-1"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/me");
    // Through the shell's token header, like every other BFF call.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: { Authorization: "Bearer id-token-1" },
    });
  });

  it("reads admin per app: one body says admin for recon and not for the pipeline", async () => {
    serve(ME);
    renderHook(() => useViewer());

    const recon = renderHook(() => useAppSubject("recon"));
    const pipeline = renderHook(() => useAppSubject("pipeline"));
    await waitFor(() => expect(recon.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(pipeline.result.current.subject).toBe("sub-1"));

    expect(recon.result.current.isAdmin).toBe(true);
    expect(pipeline.result.current.isAdmin).toBe(false);
  });

  it("hands a later mount the settled viewer on its first render", async () => {
    // Client-side navigation mounts a table after the rail already knows the answer; it must not
    // flash the unknown viewer (and default column layouts) for a value already in hand.
    serve(ME);
    await settled();

    const { result } = renderHook(() => useAppSubject("recon"));
    expect(result.current).toEqual({
      subject: "sub-1",
      groups: ["desk-admins"],
      isAdmin: true,
    });
  });

  it("keeps one object per identity, so a dependency array sees one value", async () => {
    serve(ME);
    renderHook(() => useViewer());

    const { result, rerender } = renderHook(() => useAppSubject("recon"));
    await waitFor(() => expect(result.current.subject).toBe("sub-1"));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("degrades to unknown when the route answers with an error status", async () => {
    serve({ error: "identity provider unreachable" }, 503);

    const { result } = renderHook(() => useAppSubject("recon"));
    await settled();
    expect(result.current).toEqual(UNKNOWN);
  });

  it("degrades to unknown when the request fails, rather than throwing into the nav", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );

    const { result } = renderHook(() => useAppSubject("recon"));
    await settled();
    expect(result.current).toEqual(UNKNOWN);
  });

  it("reads unknown on a 401 while the store starts the re-authentication", async () => {
    // The store's backstop, not a second one here: the hook has nothing to add to the redirect.
    serve({ error: "missing or malformed Authorization header" }, 401);

    const { result } = renderHook(() => useAppSubject("pipeline"));
    await settled();
    expect(result.current).toEqual(UNKNOWN);
    expect(reauthenticate).toHaveBeenCalledWith("unauthorized");
  });

  it("never starts or retries the request itself: a mount after a failure reads unknown and stays quiet", async () => {
    // The shell frame shows its skeleton while the store loads, unmounting the app's content. If a
    // child hook retried on mount, a failed /api/me would loop: skeleton, failure, remount, retry.
    const fetchMock = serve({ error: "identity provider unreachable" }, 503);
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const { result, unmount } = renderHook(() => useAppSubject("recon"));
    expect(result.current).toEqual(UNKNOWN);
    unmount();
    renderHook(() => useAppSubject("pipeline"));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates each field rather than trusting a partial body", async () => {
    // A body answering `admin: "yes"` must not make anyone an admin, a top-level `isAdmin` (the old
    // per-app routes' field) must be ignored, and a missing subject must stay empty rather than
    // becoming "undefined".
    serve({
      isAdmin: true,
      groups: "admins",
      apps: { recon: { admin: "yes" } },
    });

    const { result } = renderHook(() => useAppSubject("recon"));
    await settled();
    expect(result.current).toEqual(UNKNOWN);
  });
});

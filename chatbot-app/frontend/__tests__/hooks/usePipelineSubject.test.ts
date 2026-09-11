/**
 * The viewer hook behind the nav and every table.
 *
 * Two properties matter. It must start as "unknown" (empty subject, not admin) so nothing writes a
 * shared preference key or shows an admin tab before the identity is known; and it must fetch ONCE
 * per page load however many components mount it, which is what the module-scope promise cache is
 * for. The cache is module state, so each case re-imports the module.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMe = vi.fn();
vi.mock("@/lib/pipelineApi", () => ({ getMe: (...a: unknown[]) => getMe(...a) }));

/** A fresh copy of the hook with an empty cache. */
async function loadHook() {
  vi.resetModules();
  return (await import("@/hooks/usePipelineSubject")).usePipelineSubject;
}

beforeEach(() => {
  getMe.mockReset();
});

describe("usePipelineSubject", () => {
  it("starts unknown and resolves to the viewer the route returns", async () => {
    getMe.mockResolvedValue({ subject: "sub-1", groups: ["deal-desk-admins"], isAdmin: true });
    const usePipelineSubject = await loadHook();

    const { result } = renderHook(() => usePipelineSubject());
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });

    await waitFor(() => expect(result.current.subject).toBe("sub-1"));
    expect(result.current.isAdmin).toBe(true);
    expect(result.current.groups).toEqual(["deal-desk-admins"]);
  });

  it("fetches once however many components mount it", async () => {
    getMe.mockResolvedValue({ subject: "sub-1", groups: [], isAdmin: false });
    const usePipelineSubject = await loadHook();

    const a = renderHook(() => usePipelineSubject());
    const b = renderHook(() => usePipelineSubject());
    await waitFor(() => expect(a.result.current.subject).toBe("sub-1"));
    await waitFor(() => expect(b.result.current.subject).toBe("sub-1"));

    expect(getMe).toHaveBeenCalledTimes(1);
  });

  it("degrades to unknown when the route fails, rather than throwing into the nav", async () => {
    getMe.mockRejectedValue(new Error("pipeline API error 503"));
    const usePipelineSubject = await loadHook();

    const { result } = renderHook(() => usePipelineSubject());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });
  });

  it("validates each field rather than trusting a partial body", async () => {
    // A route answering `{ isAdmin: "yes" }` must not make anyone an admin, and a missing subject must
    // stay empty rather than becoming "undefined".
    getMe.mockResolvedValue({ isAdmin: "yes", groups: "admins" });
    const usePipelineSubject = await loadHook();

    const { result } = renderHook(() => usePipelineSubject());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toEqual({ subject: "", groups: [], isAdmin: false });
  });
});

/**
 * The shell's sign-out trigger: a rejection from the provider SDK must reach the user as a sentence,
 * not vanish into a `void` — the button that "does nothing" was the defect this replaces.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.fn();
vi.mock("@/components/AuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
  signOut: () => signOut(),
}));

import { SIGN_OUT_FAILED_MESSAGE, useSignOut } from "@/lib/shell/signOut";

beforeEach(() => {
  signOut.mockReset();
});

describe("useSignOut", () => {
  it("calls the auth wrapper and reports no error when it resolves", async () => {
    signOut.mockResolvedValue(undefined);
    const { result } = renderHook(() => useSignOut());
    act(() => result.current.signOut());
    await act(async () => {});
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("surfaces a rejection as a message and logs the cause", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    signOut.mockRejectedValue(new Error("uninitialized_public_client_application"));
    const { result } = renderHook(() => useSignOut());

    act(() => result.current.signOut());
    await waitFor(() => expect(result.current.error).toBe(SIGN_OUT_FAILED_MESSAGE));
    expect(consoleError).toHaveBeenCalledWith(
      "[Shell] sign out failed:",
      expect.objectContaining({ message: "uninitialized_public_client_application" }),
    );
    consoleError.mockRestore();
  });

  it("clears a previous failure when tried again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signOut.mockRejectedValueOnce(new Error("first")).mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useSignOut());

    act(() => result.current.signOut());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    act(() => result.current.signOut());
    await waitFor(() => expect(result.current.error).toBeNull());
    vi.restoreAllMocks();
  });
});

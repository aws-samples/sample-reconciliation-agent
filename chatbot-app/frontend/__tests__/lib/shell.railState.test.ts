/**
 * The rail's persisted collapsed flag and its viewport fallback.
 *
 * One key, one encoding, and three states on read — collapsed, expanded, or "never said" — because the
 * third is what lets the viewport decide for viewers who have not. Whenever storage cannot be trusted
 * the answer is "never said", and whenever `matchMedia` is missing the viewport counts as wide: the
 * state that shows the most is the right one to land in by accident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RAIL_COLLAPSED_KEY,
  WIDE_VIEWPORT_QUERY,
  isViewportWide,
  readRailPreference,
  subscribeViewportWide,
  writeRailCollapsed,
} from "@/lib/shell/railState";

const storage = window.localStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  window.matchMedia = originalMatchMedia;
});

describe("railState preference", () => {
  it("uses a shell-namespaced key", () => {
    expect(RAIL_COLLAPSED_KEY).toBe("shell:rail:collapsed");
  });

  it("reads an explicit choice for exactly 'true' or 'false', and no preference for anything else", () => {
    storage.getItem.mockReturnValue("true");
    expect(readRailPreference()).toBe(true);
    storage.getItem.mockReturnValue("false");
    expect(readRailPreference()).toBe(false);
    storage.getItem.mockReturnValue("1");
    expect(readRailPreference()).toBeNull();
    storage.getItem.mockReturnValue(null);
    expect(readRailPreference()).toBeNull();
  });

  it("writes the flag as 'true'/'false' under the key", () => {
    writeRailCollapsed(true);
    expect(storage.setItem).toHaveBeenCalledWith(RAIL_COLLAPSED_KEY, "true");
    writeRailCollapsed(false);
    expect(storage.setItem).toHaveBeenCalledWith(RAIL_COLLAPSED_KEY, "false");
  });

  it("reports no preference and stays quiet when storage throws", () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readRailPreference()).toBeNull();
    expect(() => writeRailCollapsed(true)).not.toThrow();
  });
});

describe("railState viewport", () => {
  it("asks matchMedia about the lg breakpoint", () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true });
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    expect(isViewportWide()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith(WIDE_VIEWPORT_QUERY);
    expect(WIDE_VIEWPORT_QUERY).toBe("(min-width: 1024px)");

    matchMedia.mockReturnValue({ matches: false });
    expect(isViewportWide()).toBe(false);
  });

  it("counts a viewport it cannot measure as wide", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(isViewportWide()).toBe(true);
    // And subscribing is a harmless no-op rather than a crash.
    expect(subscribeViewportWide(() => {})).toBeTypeOf("function");
  });

  it("relays breakpoint crossings until unsubscribed", () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => {
        listener = l;
      },
      removeEventListener,
    }) as unknown as typeof window.matchMedia;

    const onChange = vi.fn();
    const unsubscribe = subscribeViewportWide(onChange);
    listener!({ matches: false });
    expect(onChange).toHaveBeenCalledWith(false);

    unsubscribe();
    expect(removeEventListener).toHaveBeenCalledWith("change", listener);
  });
});

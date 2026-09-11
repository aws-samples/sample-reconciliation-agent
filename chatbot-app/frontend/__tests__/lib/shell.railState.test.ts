/**
 * The rail's persisted collapsed flag: one key, one encoding, and a fallback to "expanded" whenever
 * storage cannot be trusted — the state that shows the most is the right one to land in by accident.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RAIL_COLLAPSED_KEY, readRailCollapsed, writeRailCollapsed } from "@/lib/shell/railState";

const storage = window.localStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  storage.getItem.mockReset();
  storage.setItem.mockReset();
});

describe("railState", () => {
  it("uses a shell-namespaced key", () => {
    expect(RAIL_COLLAPSED_KEY).toBe("shell:rail:collapsed");
  });

  it("reads collapsed only for the exact string 'true'", () => {
    storage.getItem.mockReturnValue("true");
    expect(readRailCollapsed()).toBe(true);
    storage.getItem.mockReturnValue("false");
    expect(readRailCollapsed()).toBe(false);
    storage.getItem.mockReturnValue("1");
    expect(readRailCollapsed()).toBe(false);
    storage.getItem.mockReturnValue(null);
    expect(readRailCollapsed()).toBe(false);
  });

  it("writes the flag as 'true'/'false' under the key", () => {
    writeRailCollapsed(true);
    expect(storage.setItem).toHaveBeenCalledWith(RAIL_COLLAPSED_KEY, "true");
    writeRailCollapsed(false);
    expect(storage.setItem).toHaveBeenCalledWith(RAIL_COLLAPSED_KEY, "false");
  });

  it("falls back to expanded and stays quiet when storage throws", () => {
    storage.getItem.mockImplementation(() => {
      throw new Error("SecurityError");
    });
    storage.setItem.mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(readRailCollapsed()).toBe(false);
    expect(() => writeRailCollapsed(true)).not.toThrow();
  });
});

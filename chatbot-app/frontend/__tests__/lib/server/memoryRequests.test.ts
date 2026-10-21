/**
 * The memory request helpers both apps' `/memory` routes share. The delete parser is pinned through
 * each route (reconMemoryDelete.test.ts, pipelineMemory.test.ts); what is pinned here is the id
 * sanitiser, which has no route of its own.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_DELETE_IDS,
  memorySafeId,
  parseMemoryDeleteIds,
} from "@/lib/server/memoryRequests";

describe("memorySafeId", () => {
  it("makes ids safe for AgentCore actor/session fields", () => {
    expect(memorySafeId("user@example.test|abc def")).toBe(
      "user-example-test-abc-def",
    );
    expect(memorySafeId("")).toBe("unknown");
    expect(memorySafeId("x".repeat(150))).toHaveLength(100);
  });

  it("replaces rather than strips, so a value of only rejected characters keeps its length", () => {
    expect(memorySafeId("###")).toBe("---");
  });
});

describe("parseMemoryDeleteIds", () => {
  it("de-duplicates after trimming and refuses more than the cap", () => {
    expect(parseMemoryDeleteIds({ ids: ["a", " b ", "a"] })).toEqual([
      "a",
      "b",
    ]);
    const ids = Array.from({ length: MAX_DELETE_IDS + 1 }, (_, i) => `id-${i}`);
    expect(() => parseMemoryDeleteIds({ ids })).toThrow(/at most 50/);
  });
});

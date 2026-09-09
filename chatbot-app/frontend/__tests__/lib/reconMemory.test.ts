import { describe, expect, it } from "vitest";

import { hasDerivableLesson, type LessonEvent } from "@/lib/reconMemory";

/** A decision event with no rationale attached — the shape bulk queue triage produces. */
function event(overrides: Partial<LessonEvent> = {}): LessonEvent {
  return {
    item_id: "manual-scenario1-1-jahqpu",
    trigger: "BULK_STATUS",
    disposition: "CLOSED_NO_ACTION",
    ...overrides,
  };
}

describe("hasDerivableLesson", () => {
  it("rejects a bare bulk status change", () => {
    // This is the event that produced "The user made an analyst decision for reconciliation item
    // manual-scenario1-1-jahqpu with a bulk status of CLOSED_NO_ACTION" — a record that generalizes
    // to nothing, because the event itself says nothing about why.
    expect(hasDerivableLesson(event())).toBe(false);
  });

  it("accepts a decision carrying an analyst comment", () => {
    expect(
      hasDerivableLesson(
        event({ user_comment: "Facility mapping must be fixed first." }),
      ),
    ).toBe(true);
  });

  it("accepts an approval carrying the agent's prior recommendation", () => {
    expect(
      hasDerivableLesson(
        event({
          trigger: "USER_APPROVED",
          prior_recommendation: "Match against the 2026-08 paydown schedule.",
        }),
      ),
    ).toBe(true);
  });

  it("treats a whitespace-only comment as no rationale at all", () => {
    expect(hasDerivableLesson(event({ user_comment: "   \n " }))).toBe(false);
  });
});

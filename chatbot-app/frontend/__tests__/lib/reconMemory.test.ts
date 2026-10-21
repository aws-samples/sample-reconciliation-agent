// @vitest-environment node
/**
 * `reconMemory` — analyst decisions written to the recon AgentCore Memory as conversational events.
 *
 * Two halves. `hasDerivableLesson` decides whether a decision carries anything a lesson could be
 * extracted from. `recordLessonMemoryEvent` is the write itself, and what matters about it is pinned
 * here because it is advisory by design: nothing is sent without a derivable lesson or without a
 * configured memory, the event is one USER turn grouped by domain and keyed on the item, and a
 * memory failure is warned about and swallowed — it must never fail the analyst's decision.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { agentCoreModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";

import type { LessonEvent } from "@/lib/reconMemory";

const MEMORY_ID = "recon_test_memory-abc123";
const env = scopedEnv({ RECON_MEMORY_ID: MEMORY_ID, AWS_REGION: "us-east-1" });
afterAll(() => env.restore());

const agentcoreSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock-agentcore", () =>
  agentCoreModule(agentcoreSend),
);

const { hasDerivableLesson, recordLessonMemoryEvent } =
  await import("@/lib/reconMemory");

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

describe("recordLessonMemoryEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    env.set({ RECON_MEMORY_ID: MEMORY_ID });
  });

  it("sends nothing for a decision with no derivable lesson", async () => {
    await recordLessonMemoryEvent(event());
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("writes the decision as one USER event, grouped by domain and keyed on the item", async () => {
    agentcoreSend.mockResolvedValue({ event: { eventId: "evt-1" } });
    await recordLessonMemoryEvent(
      event({
        domain: "loan ops#1",
        class_id: "C-7",
        trigger: "USER_APPROVED",
        disposition: "RESOLVED",
        user_comment: "Facility mapping must be fixed first.",
        prior_recommendation: "Match against the 2026-08 paydown schedule.",
      }),
    );

    expect(agentcoreSend).toHaveBeenCalledTimes(1);
    const cmd = agentcoreSend.mock.calls[0][0];
    // actorId is the domain and sessionId the item, both reduced to the memory API's id charset.
    expect(cmd).toMatchObject({
      __cmd: "CreateEvent",
      memoryId: MEMORY_ID,
      actorId: "loan-ops-1",
      sessionId: "lesson-manual-scenario1-1-jahqpu",
    });
    expect(cmd.eventTimestamp).toBeInstanceOf(Date);
    expect(cmd.payload).toHaveLength(1);
    expect(cmd.payload[0].conversational.role).toBe("USER");
    expect(cmd.payload[0].conversational.content.text).toBe(
      [
        "Analyst decision for reconciliation item manual-scenario1-1-jahqpu (domain loan ops#1, class C-7): USER_APPROVED / RESOLVED.",
        "Agent had recommended: Match against the 2026-08 paydown schedule.",
        "Analyst comment: Facility mapping must be fixed first.",
      ].join("\n"),
    );
  });

  it("names an unknown domain and class and omits the lines it has nothing for", async () => {
    agentcoreSend.mockResolvedValue({ event: { eventId: "evt-2" } });
    await recordLessonMemoryEvent(
      event({ user_comment: "Rounding only.", disposition: undefined }),
    );
    const cmd = agentcoreSend.mock.calls[0][0];
    expect(cmd.actorId).toBe("unknown");
    expect(cmd.payload[0].conversational.content.text).toBe(
      [
        "Analyst decision for reconciliation item manual-scenario1-1-jahqpu (domain unknown, class unknown): BULK_STATUS.",
        "Analyst comment: Rounding only.",
      ].join("\n"),
    );
  });

  it("swallows a memory failure with a warning so the decision itself is never blocked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    agentcoreSend.mockRejectedValue(new Error("ThrottlingException"));
    await expect(
      recordLessonMemoryEvent(event({ user_comment: "Rounding only." })),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "recon memory event failed:",
      "ThrottlingException",
    );
    warn.mockRestore();
  });

  it("is a no-op when RECON_MEMORY_ID is unset", async () => {
    // Re-imported with the variable cleared, so the case holds whether the module reads the id when
    // it loads or when it is called.
    vi.resetModules();
    env.set({ RECON_MEMORY_ID: "" });
    const fresh = await import("@/lib/reconMemory");
    await fresh.recordLessonMemoryEvent(
      event({ user_comment: "Rounding only." }),
    );
    expect(agentcoreSend).not.toHaveBeenCalled();
  });
});

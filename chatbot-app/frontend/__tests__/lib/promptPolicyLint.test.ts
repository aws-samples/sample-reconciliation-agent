/**
 * Tests for lintPromptPolicy.
 *
 * The fixtures are real text, not invented: RECOMMENDED_EXCERPT is from
 * rec_sysprompt_syncverify (2026-08-03), a run whose baseline contained NO approval language —
 * the optimizer injected it anyway. LIVE_CORE_EXCERPT is the shared core that baseline came from,
 * which must lint clean or the guard would cry wolf on every deploy.
 */
import { describe, it, expect } from "vitest";
import { lintPromptPolicy } from "@/lib/promptPolicyLint";

const RECOMMENDED_EXCERPT = `## What happens to your proposal

The platform scores every proposal by combining your stated confidence with self-consistency,
grounding, and extraction alerts. Above the auto-resolve threshold it is actioned; below it,
or with no action, it routes to an analyst queue.

Before taking any action with real-world consequences (sending mail, writing ledger status),
state the planned action and wait for explicit approval. Do not treat silence as consent.`;

const LIVE_CORE_EXCERPT = `You have a **library of skills** — reusable investigation and resolution _procedures_, each backed
by one or more gateway tools. **Skills are NOT categories, and you are not choosing exactly one.**

The platform scores every proposal by combining your stated confidence with signals it computes
itself. A score above the configured auto-resolve threshold is actioned automatically. A score
below it, or a proposal with no action, is routed to an analyst queue for approval or correction.`;

describe("lintPromptPolicy", () => {
  it("flags the approval policy the optimizer injects", () => {
    const warnings = lintPromptPolicy(RECOMMENDED_EXCERPT);

    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/wait for approval it is never offered/);
    expect(warnings[1]).toMatch(/interactive approver/);
  });

  it("passes the live shared core clean", () => {
    // "routed to an analyst queue for approval or correction" describes the platform's own
    // behavior — it must NOT trip the wait-for-approval rule, or every deploy warns.
    expect(lintPromptPolicy(LIVE_CORE_EXCERPT)).toEqual([]);
  });

  it("flags the pre-fix autonomy claims", () => {
    expect(
      lintPromptPolicy(
        "Never auto-apply — the proposal is reviewed in the queue.",
      ),
    ).toHaveLength(1);
    expect(
      lintPromptPolicy(
        "Always propose only — a human analyst approves or corrects every recommendation.",
      ),
    ).toHaveLength(1);
  });

  it("flags the stale skills-as-taxonomy wording", () => {
    const warnings = lintPromptPolicy(
      "Classify the item against the available classification types (the Skills catalog).",
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/procedures/);
  });

  it("returns nothing for empty input", () => {
    expect(lintPromptPolicy("")).toEqual([]);
  });
});

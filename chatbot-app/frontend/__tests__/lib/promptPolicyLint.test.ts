/**
 * Tests for lintPromptPolicy.
 *
 * The fixtures are real text, not invented: RECOMMENDED_EXCERPT is an optimizer recommendation whose
 * baseline contained NO approval language — the optimizer injected it anyway. LIVE_CORE_EXCERPT is the
 * shared core that baseline came from, which must lint clean or the guard would cry wolf on every
 * deploy.
 */
import { describe, it, expect } from "vitest";
import { lintPromptPolicy } from "@/lib/promptPolicyLint";

const RECOMMENDED_EXCERPT = `## What happens to your proposal

The platform scores every proposal by combining your stated confidence with self-consistency,
grounding, and extraction alerts. Above the auto-resolve threshold it is actioned; below it,
or with no action, it routes to an analyst queue.

Before taking any action with real-world consequences (sending mail, writing ledger status),
state the planned action and wait for explicit approval. Do not treat silence as consent.`;

// Kept in step with agent-blueprint/recon-agent/system-prompt.md: the excerpt has to track that file,
// or "passes the live shared core clean" stops being a statement about the deployed prompt.
const LIVE_CORE_EXCERPT = `You have a **library of skills** — reusable investigation and resolution _procedures_, each backed
by one or more gateway tools. **Skills are NOT categories, and you are not choosing exactly one.**

The platform does not grade your prose. It counts: for the skill you classified into, it takes the
**required** steps that skill prescribes and computes the fraction you reported as satisfied. That
fraction is the score. Nothing you assert about your own certainty moves this number. A score above
the threshold is actioned automatically; a score below it, or a proposal with no action, is routed to
an analyst queue for approval or correction.`;

describe("lintPromptPolicy", () => {
  it("flags the approval policy the optimizer injects", () => {
    const warnings = lintPromptPolicy(RECOMMENDED_EXCERPT);

    // Three, not two: "combining your stated confidence with self-consistency, grounding, and
    // extraction alerts" describes a composite score that does not exist, so the same fixture trips
    // the self-grading rule as well. Warnings come back in rule order, and the self-grading rule is
    // last.
    expect(warnings.length).toBe(3);
    expect(warnings[0]).toMatch(/wait for approval it is never offered/);
    expect(warnings[1]).toMatch(/interactive approver/);
    expect(warnings[2]).toMatch(/grade its own certainty/);
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

  it("flags a prompt that asks the agent to grade its own certainty", () => {
    // The first string is verbatim the sentence neither system prompt may carry in step 1 — the exact
    // text this rule exists to keep out.
    for (const text of [
      "**Characterize the break.** Identify what kind of exception this is and state your reasoning with a confidence in [0,1].",
      "Report your confidence in the classification.",
      "Include your own certainty alongside the evidence.",
      "The platform combines your stated confidence with the evidence fraction.",
      "Emit classification_confidence as a decimal.",
      "Set verbalized_confidence on the proposal.",
    ]) {
      const warnings = lintPromptPolicy(text);

      expect(warnings, text).toHaveLength(1);
      expect(warnings[0]).toMatch(/grade its own certainty/);
    }
  });

  it("does not flag the live prompt's sentence denying self-reported certainty", () => {
    // The live core has to be able to SAY the thing this rule bans asking for. Pinned separately
    // from "passes the live shared core clean" so that widening the rule's verb list — which would
    // make "assert" match here — fails on an assertion that names the reason.
    expect(
      lintPromptPolicy(
        "Nothing you assert about your own certainty moves this number.",
      ),
    ).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(lintPromptPolicy("")).toEqual([]);
  });
});

/**
 * Flags system-prompt text that contradicts how this platform actually runs the agent.
 *
 * Why this exists: AgentCore's system-prompt optimizer applies its own safety pass and INJECTS a
 * confirmation policy regardless of the baseline it was given. Verified live on 2026-08-03 — the
 * baseline fed to `rec_sysprompt_syncverify` contained no approval language at all, yet the
 * recommendation came back with "state the planned action and wait for explicit approval. Do not
 * treat silence as consent", and its own explanation says it "verified that the confirmation
 * policy ... was preserved" and "ran automated checks to confirm the absence of unsafe phrases
 * such as 'autonomously' or 'without confirmation'". So this is a property of the service, not a
 * defect in our prompt, and it will recur on every run.
 *
 * That text is wrong here twice over: the model holds no tool that changes a downstream system
 * (see agent-blueprint/recon-agent/strands_investigator.py), and a proposal whose composite
 * confidence clears the auto-resolve threshold is executed by the platform with no human in the
 * loop (backend/recon_core/auto_resolve.autonomous_execute). An agent told to wait for approval
 * it will never be offered either stalls or narrates a request nobody reads.
 *
 * The lint does not rewrite anything — silently editing an optimizer suggestion would make the
 * deployed prompt untraceable to its recommendation. It surfaces the offending lines so an AI
 * Engineer edits them deliberately before the text goes live.
 */

interface PolicyRule {
  /** Case-insensitive pattern matched against the whole prompt. */
  pattern: RegExp;
  /** What is wrong, in the AI Engineer's terms. */
  message: string;
}

const RULES: PolicyRule[] = [
  {
    pattern:
      /wait for (?:explicit )?(?:user )?(?:approval|confirmation|sign-?off)/i,
    message:
      "Tells the agent to wait for approval it is never offered — above-threshold proposals are actioned by the platform, and the model holds no downstream write tool.",
  },
  {
    pattern: /(?:do not|don't) treat silence as consent/i,
    message:
      "Implies an interactive approver in the agent's turn. There is none: the decision happens after the turn ends.",
  },
  {
    pattern: /never auto-?(?:apply|resolve|execute)/i,
    message:
      "Contradicts the auto-resolve path — the platform does execute above-threshold proposals automatically.",
  },
  {
    // Tolerates a conjunction between the verb and the quantifier, as in the pre-fix wording
    // "a human analyst approves or corrects every recommendation".
    pattern:
      /human (?:analyst )?(?:approves|reviews|confirms)[^.\n]{0,40}?\b(?:every|each|all)\b/i,
    message:
      "Claims every proposal is reviewed by a human. Only below-threshold proposals reach the analyst queue.",
  },
  {
    pattern: /classification types|skills? catalog(?:ue)?/i,
    message:
      "Treats the skills as a classification taxonomy. Skills are procedures, and several may apply to one item — this is the stale wording the shared-core fix removed.",
  },
];

/**
 * Lint a candidate system prompt against this platform's actual autonomy semantics.
 *
 * @param text - the candidate prompt (an optimizer recommendation, or hand-edited text)
 * @returns one message per rule that matched, in rule order; empty when the text is consistent
 */
export function lintPromptPolicy(text: string): string[] {
  if (!text) return [];
  return RULES.filter((r) => r.pattern.test(text)).map((r) => r.message);
}

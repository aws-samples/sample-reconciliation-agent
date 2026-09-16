/**
 * Flags system-prompt text that contradicts how this platform actually runs the agent.
 *
 * Why this exists: AgentCore's system-prompt optimizer applies its own safety pass and INJECTS a
 * confirmation policy regardless of the baseline it was given. A baseline containing no approval
 * language at all comes back with "state the planned action and wait for explicit approval. Do not
 * treat silence as consent", and the recommendation's own explanation claims it "verified that the
 * confirmation policy ... was preserved" and "ran automated checks to confirm the absence of unsafe
 * phrases such as 'autonomously' or 'without confirmation'". So this is a property of the service,
 * not a defect in our prompt, and it recurs on every run.
 *
 * That text is wrong here twice over: the model holds no tool that changes a downstream system
 * (see agent-blueprint/recon-agent/strands_investigator.py), and a proposal whose computed
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
    // Tolerates a conjunction between the verb and the quantifier, as in "a human analyst approves
    // or corrects every recommendation".
    pattern:
      /human (?:analyst )?(?:approves|reviews|confirms)[^.\n]{0,40}?\b(?:every|each|all)\b/i,
    message:
      "Claims every proposal is reviewed by a human. Only below-threshold proposals reach the analyst queue.",
  },
  {
    pattern: /classification types|skills? catalog(?:ue)?/i,
    message:
      "Treats the skills as a classification taxonomy. Skills are procedures, and several may apply to one item.",
  },
  {
    // The platform records no model-reported confidence anywhere, and `submit_proposal` declares no
    // property for one. So this is not a style preference: a prompt asking for a rating asks for
    // something the tool has nowhere to put. Four shapes are matched — the bare interval, an
    // imperative to state one's own confidence, the optimizer's "your stated confidence" (which also
    // asserts a composite that does not exist), and the two banned field names, in case an optimizer
    // run resurrects them from a stale baseline.
    //
    // The verb list is what keeps this off the live core, which says "Nothing you assert about your
    // own certainty moves this number" — a NEGATION of the same idea, and the one sentence in the
    // prompt that must survive this lint. `assert` is deliberately absent below; the fixture test
    // pins that, so widening the verbs without re-reading the live prompt will fail loudly.
    pattern:
      /confidence in \[0,\s*1\]|(?:state|report|rate|give|include)[^.\n]{0,40}\byour\s+(?:own\s+)?(?:confidence|certainty)|your\s+stated\s+confidence|classification_confidence|verbalized_confidence/i,
    message:
      "Asks the agent to grade its own certainty. Nothing reads a self-reported number and submit_proposal has no property for one — the score is computed from the evidence steps the agent reports (backend/recon_core/confidence.score_proposal).",
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

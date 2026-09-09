import {
  BedrockAgentCoreClient,
  CreateEventCommand,
} from "@aws-sdk/client-bedrock-agentcore";

// Writes analyst decisions into the recon AgentCore Memory as conversational events. The
// memory's `lessons_learned` strategy — CUSTOM with a SEMANTIC_OVERRIDE extraction prompt, namespace
// reconciliation/lessons/{actorId} — extracts + consolidates them into retrievable records; the agent
// recalls them before classifying/investigating similar items. actorId = recon domain, so lessons
// group per domain. Decisions with no rationale are not sent at all; see hasDerivableLesson.
//
// RECON_MEMORY_ID is distinct from the chatbot app's MEMORY_ID. Empty -> feature disabled.
// Best-effort by design: a memory failure must never block or fail the analyst's decision.

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RECON_MEMORY_ID = process.env.RECON_MEMORY_ID ?? "";

export interface LessonEvent {
  item_id: string;
  domain?: string;
  class_id?: string;
  trigger: string; // USER_APPROVED | USER_CORRECTION | BULK_STATUS
  disposition?: string;
  user_comment?: string;
  prior_recommendation?: string;
}

function sanitizeId(s: string): string {
  // Memory actor/session ids permit a restricted charset; item ids can carry '#', spaces, etc.
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 100);
}

/**
 * Whether a decision carries anything a lesson could be derived from.
 *
 * The memory strategy's extraction prompt asks for generalizable lessons and returns an empty list
 * when there is no rationale to generalize. A bulk `CLOSED_NO_ACTION` with no comment is exactly that
 * case: the event says what was decided and nothing about why, so no prompt — however well written —
 * can derive a rule from it, and sending it only spends a Bedrock invocation to produce noise.
 *
 * An approval with the agent's prior recommendation attached DOES qualify: the recommendation is the
 * reasoning being ratified.
 *
 * The DynamoDB lessons ledger is unaffected and still records every decision, including the ones
 * skipped here — the audit trail is its job, not long-term memory's.
 *
 * @param f the decision about to be recorded.
 * @returns true when the event carries an analyst comment or a prior agent recommendation.
 */
export function hasDerivableLesson(f: LessonEvent): boolean {
  return (
    (f.user_comment ?? "").trim().length > 0 ||
    (f.prior_recommendation ?? "").trim().length > 0
  );
}

export async function recordLessonMemoryEvent(f: LessonEvent): Promise<void> {
  if (!RECON_MEMORY_ID) return;
  if (!hasDerivableLesson(f)) return;
  const lines = [
    `Analyst decision for reconciliation item ${f.item_id}` +
      ` (domain ${f.domain ?? "unknown"}, class ${f.class_id ?? "unknown"}): ${f.trigger}` +
      (f.disposition ? ` / ${f.disposition}` : "") +
      ".",
    f.prior_recommendation
      ? `Agent had recommended: ${f.prior_recommendation}`
      : "",
    f.user_comment ? `Analyst comment: ${f.user_comment}` : "",
  ].filter(Boolean);
  try {
    await new BedrockAgentCoreClient({ region: REGION }).send(
      new CreateEventCommand({
        memoryId: RECON_MEMORY_ID,
        actorId: sanitizeId(f.domain ?? "unknown"),
        sessionId: sanitizeId(`lesson-${f.item_id}`),
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: "USER",
              content: { text: lines.join("\n") },
            },
          },
        ],
      }),
    );
  } catch (err) {
    // Advisory memory only — log and move on; the DynamoDB ledger already has the lesson.
    console.warn("recon memory event failed:", (err as Error).message);
  }
}

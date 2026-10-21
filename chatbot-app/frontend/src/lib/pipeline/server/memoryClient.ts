/**
 * AgentCore Memory access for the two memories the pipeline uses (design §8), bound over the shared
 * client in `@/lib/server/memoryClient`.
 *
 * - The KNOWLEDGE memory holds situational parsing rules. Written as USER events (the `edge_cases`
 *   strategy extracts and consolidates them into records under
 *   `deal-pipeline/edge-cases/deal-desk`); read back by the parser before each run and by the
 *   Memory Manager panel here.
 * - The CHAT memory holds the assistant's turns so a session survives a page reload. Events only,
 *   no strategy.
 *
 * Both are optional deployments. When an id is unset every read returns empty and every write is a
 * no-op that reports `false` or `null`, so the rest of the BFF and the UI work without them; the
 * ROUTES decide whether a no-op write should be a 409 (it is — a delete that deleted nothing must
 * not look like a success).
 *
 * What is the pipeline's own and therefore stays here: which environment variable names each
 * memory, the desk actor and its namespace, the wording of a rule event, and the process-wide SDK
 * clients from `./aws` (built once, so a route hit once a second does not re-resolve credentials).
 * The ids are read at call time, as every pipeline environment value is.
 */

import type {
  ChatMessage,
  EmailRecord,
  FieldEvidence,
  FieldOverride,
  FieldValues,
  MemoryRecord,
} from "@/lib/pipeline/types";
import type { MemoryStrategyResponse } from "@/lib/memoryStrategy";
import { fieldDef } from "@/lib/pipeline/omsSchema";
import {
  createMemoryClient,
  type BatchDeleteOutcome,
  type MemoryClient,
} from "@/lib/server/memoryClient";
import { memorySafeId } from "@/lib/server/memoryRequests";
import { agentcore, agentcoreControl } from "./aws";
import { env } from "./env";

/** The desk is one actor: every edge-case rule is shared by everyone who reviews deals. */
export const KNOWLEDGE_ACTOR_ID = "deal-desk";
/** Where the `edge_cases` strategy files consolidated records for that actor. */
export const EDGE_CASES_NAMESPACE = `deal-pipeline/edge-cases/${KNOWLEDGE_ACTOR_ID}`;

/**
 * The provenance an override lesson carries as event metadata. The `edge_cases` strategy copies all
 * three onto the record it extracts (Terraform: `provenance_keys` in modules/deal-pipeline/memory.tf,
 * which must name the same keys), so a record says which override, reviewer and deal taught it, and
 * a retract can find exactly that record. Three is the service's limit; the field and the reason are
 * read back from the override on the deal.
 */
export const PROVENANCE_KEYS = { overrideId: "override_id", author: "author", dealId: "deal_id" } as const;

export type { BatchDeleteOutcome };

/** The process-wide SDK clients, handed to the shared client as thunks so an unset id builds none. */
const CLIENTS = { agentcore, agentcoreControl };

/** The knowledge memory, bound at call time to `KNOWLEDGE_MEMORY_ID` (empty when not deployed). */
export function knowledgeMemory(): MemoryClient {
  return createMemoryClient({
    memoryId: env.knowledgeMemoryId(),
    clients: CLIENTS,
  });
}

/** The chat memory, bound at call time to `CHAT_MEMORY_ID` (empty when not deployed). */
export function chatMemory(): MemoryClient {
  return createMemoryClient({ memoryId: env.chatMemoryId(), clients: CLIENTS });
}

export function isKnowledgeMemoryConfigured(): boolean {
  return knowledgeMemory().configured;
}

export function isChatMemoryConfigured(): boolean {
  return chatMemory().configured;
}

/**
 * Semantic search over consolidated records — the same call the parser makes before a run.
 *
 * @returns up to `topK` records ranked by relevance; `[]` when the memory is not configured.
 */
export function retrieveRecords(
  namespace: string,
  query: string,
  topK: number,
): Promise<MemoryRecord[]> {
  return knowledgeMemory().retrieveRecords(namespace, query, topK);
}

/**
 * Every consolidated record in a namespace, newest first — what the Memory Manager panel shows.
 *
 * `ListMemoryRecords` rather than a search with a dummy query: the panel is an inventory, and a
 * search returns a relevance-ranked subset that hides whatever the query happened not to match.
 */
export function listRecords(
  namespace: string = EDGE_CASES_NAMESPACE,
): Promise<MemoryRecord[]> {
  return knowledgeMemory().listRecords(namespace);
}

/**
 * The records one override's lesson produced, found by the provenance the strategy copied onto
 * them. Usually one; none while the lesson is still being extracted (1–3 minutes), or when it did
 * not generalise into a rule.
 */
export function recordsForOverride(overrideId: string): Promise<MemoryRecord[]> {
  return knowledgeMemory().listRecords(EDGE_CASES_NAMESPACE, {
    [PROVENANCE_KEYS.overrideId]: overrideId,
  });
}

/**
 * Save a situational rule as a USER event in the knowledge memory.
 *
 * The event text is the rule followed by its rationale, phrased so the `edge_cases` extraction
 * prompt has both the instruction and the evidence it asks for. The session id groups the events
 * of one conversation (`chat-<session>`) or one manual add.
 *
 * @returns the event id, or null when the knowledge memory is not configured.
 */
export function createRuleEvent(
  rule: string,
  rationale: string,
  sessionId: string,
): Promise<string | null> {
  const text = rationale.trim()
    ? `Deal-parsing rule: ${rule.trim()}\nRationale: ${rationale.trim()}`
    : `Deal-parsing rule: ${rule.trim()}`;
  return knowledgeMemory().createEvent({
    actorId: KNOWLEDGE_ACTOR_ID,
    sessionId: memorySafeId(sessionId),
    role: "USER",
    text,
  });
}

/**
 * The deal attributes that most often decide how a field is booked — the triggers the `edge_cases`
 * extraction looks for. Quoted with each override lesson so the extractor can write "when <trigger>,
 * <field> is <value>" rather than a fact about one deal. A short list on purpose: the whole record is
 * seventy columns, and most of them are noise to a rule.
 */
const LESSON_CONTEXT_FIELDS = [
  "pipeline_type",
  "security_type",
  "uop",
  "fixed_floating",
  "is_secured",
  "secured_level",
  "currency",
  "maturity_terms",
  "sp_issue_rating",
  "left_agent",
] as const;

/** Longest stretch of the parser's evidence quoted in a lesson; the extractor needs the gist. */
const LESSON_EXCERPT_CHARS = 400;

/** What an override lesson quotes besides the override itself. */
export interface OverrideLessonContext {
  /** The email the deal came from, when it could be read. */
  email: Pick<EmailRecord, "source_kind" | "subject"> | null;
  /** The deal's fields after the override. */
  fields: FieldValues;
  /** The parser's evidence for the overridden field, when it recorded any. */
  evidence?: FieldEvidence;
  /** On a deal of several orders: every order's name, and the ones this override changed. */
  orders?: { labels: string[]; scope: number[] };
}

/**
 * The event text for one override: what the parser produced, what the reviewer changed it to, why,
 * and the deal attributes a rule could hang on.
 *
 * Written as a desk correction because that is one of the inputs the extraction prompt is told to
 * treat as a rule source. A reason that does not generalise ("the notice had a typo") yields no
 * record, which is the extractor's job, not this one's.
 */
export function overrideLessonText(override: FieldOverride, context: OverrideLessonContext): string {
  const label = (key: string) => fieldDef(key)?.label ?? key;
  const show = (v: string) => (v ? `"${v}"` : "(blank)");
  const lines = [
    "Deal-desk override of a parsed OMS field.",
    `Field: ${label(override.field)}`,
  ];
  const o = context.orders;
  if (o && o.labels.length > 1) {
    // Several orders from one email: say which this corrects, so the extractor can tell "the EUR
    // tranche" from "every tranche" (design §15).
    lines.push(
      o.scope.length === o.labels.length
        ? `Applies to all ${o.labels.length} orders of the deal: ${o.labels.join(", ")}`
        : `Order: ${o.scope.map((i) => o.labels[i]).join(", ")} (of ${o.labels.length}: ${o.labels.join(", ")})`,
    );
  }
  lines.push(`Parser value: ${show(override.parsed_value)}`);
  if (override.previous_value !== override.parsed_value) {
    lines.push(`Value before this override: ${show(override.previous_value)}`);
  }
  lines.push(`Corrected value: ${show(override.value)}`, `Reviewer's reason: ${override.reason}`);
  if (override.stage === "break") {
    const codes = override.upload_error_codes?.length
      ? ` (codes: ${override.upload_error_codes.join(", ")})`
      : "";
    lines.push(`Made to fix an OMS upload rejection${codes}.`);
  }
  const excerpt = context.evidence?.excerpt?.trim();
  if (excerpt) {
    const cut = excerpt.length > LESSON_EXCERPT_CHARS ? `${excerpt.slice(0, LESSON_EXCERPT_CHARS)}…` : excerpt;
    lines.push(`Email text the parser read: ${cut}`);
  }
  if (context.evidence?.rule) lines.push(`Rule the parser applied: ${context.evidence.rule}`);
  const attrs = LESSON_CONTEXT_FIELDS.filter((k) => k !== override.field && context.fields[k])
    .map((k) => `${label(k)} = ${context.fields[k]}`);
  if (attrs.length) lines.push(`Deal attributes: ${attrs.join("; ")}`);
  if (context.email) {
    lines.push(`Source: ${context.email.source_kind} email, subject "${context.email.subject}"`);
  }
  return lines.join("\n");
}

/**
 * Send one override to the knowledge memory as a lesson.
 *
 * Same actor as every desk rule, so the record lands in the namespace the parser recalls from. One
 * session per deal, so the overrides of one deal reach the extractor together. The event carries
 * the override's provenance (`PROVENANCE_KEYS`) for the record to inherit.
 *
 * @returns the event id, or null when the knowledge memory is not configured.
 */
export function createOverrideEvent(
  override: FieldOverride,
  dealId: string,
  context: OverrideLessonContext,
): Promise<string | null> {
  return knowledgeMemory().createEvent({
    actorId: KNOWLEDGE_ACTOR_ID,
    sessionId: memorySafeId(`override-${dealId}`),
    role: "USER",
    text: overrideLessonText(override, context),
    metadata: {
      [PROVENANCE_KEYS.overrideId]: override.override_id,
      [PROVENANCE_KEYS.author]: override.actor,
      [PROVENANCE_KEYS.dealId]: dealId,
    },
  });
}

/**
 * Delete consolidated records by id.
 *
 * @returns per-record outcome, or null when the knowledge memory is not configured (the route turns
 *   that into a 409 rather than an empty success).
 */
export function batchDelete(ids: string[]): Promise<BatchDeleteOutcome | null> {
  return knowledgeMemory().batchDelete(ids);
}

/** The knowledge memory's strategy configuration (control plane), projected for the panel. */
export function getStrategy(): Promise<MemoryStrategyResponse> {
  return knowledgeMemory().getStrategy();
}

/**
 * Persist one chat turn to the short-term chat memory.
 *
 * @param actorId the verified caller's subject — sessions are private to the person who had them.
 * @returns true when written, false when the chat memory is not configured.
 */
export function appendChatEvent(
  sessionId: string,
  role: ChatMessage["role"],
  text: string,
  actorId: string,
): Promise<boolean> {
  return chatMemory().appendChatEvent(sessionId, role, text, actorId);
}

/**
 * Rebuild a session's transcript from its events, oldest first.
 *
 * @returns `[]` when the chat memory is not configured or the session has no events.
 */
export function listChatEvents(
  sessionId: string,
  actorId: string,
): Promise<ChatMessage[]> {
  return chatMemory().listChatEvents(sessionId, actorId);
}

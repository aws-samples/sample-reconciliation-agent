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

import type { ChatMessage, MemoryRecord } from "@/lib/pipeline/types";
import type { MemoryStrategyResponse } from "@/lib/memoryStrategy";
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

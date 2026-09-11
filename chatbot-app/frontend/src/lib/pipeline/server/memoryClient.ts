/**
 * AgentCore Memory access for the two memories the pipeline uses (design §8).
 *
 * - The KNOWLEDGE memory holds situational parsing rules. Written as USER events (the `edge_cases`
 *   strategy extracts and consolidates them into records under
 *   `deal-pipeline/edge-cases/deal-desk`); read back by the parser before each run and by the
 *   Memory Manager panel here.
 * - The CHAT memory holds the assistant's turns so a session survives a page reload. Events only,
 *   no strategy.
 *
 * Both are optional deployments. When an id is unset every read returns empty and every write is a
 * no-op that reports `false`, so the rest of the BFF and the UI work without them; the ROUTES decide
 * whether a no-op write should be a 409 (it is — a delete that deleted nothing must not look like a
 * success).
 */

import {
  BatchDeleteMemoryRecordsCommand,
  CreateEventCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import { GetMemoryCommand } from "@aws-sdk/client-bedrock-agentcore-control";

import type { ChatMessage, MemoryRecord } from "@/lib/pipeline/types";
import { agentcore, agentcoreControl } from "./aws";
import { env } from "./env";
import { memorySafeId } from "./ids";
import { toStrategyInfo, type MemoryStrategyResponse } from "./memoryStrategy";

/** The desk is one actor: every edge-case rule is shared by everyone who reviews deals. */
export const KNOWLEDGE_ACTOR_ID = "deal-desk";
/** Where the `edge_cases` strategy files consolidated records for that actor. */
export const EDGE_CASES_NAMESPACE = `deal-pipeline/edge-cases/${KNOWLEDGE_ACTOR_ID}`;
// One page is plenty for the panel; a desk with more than this many edge cases has outgrown the demo.
const PAGE_SIZE = 100;

export function isKnowledgeMemoryConfigured(): boolean {
  return env.knowledgeMemoryId() !== "";
}

export function isChatMemoryConfigured(): boolean {
  return env.chatMemoryId() !== "";
}

/** Project an SDK record summary onto the wire type, dropping records with no text. */
function toRecord(r: MemoryRecordSummary, namespace: string): MemoryRecord | null {
  // MemoryContent is a union member { text: ... }; the pipeline only ever writes text.
  const content = r.content && "text" in r.content ? (r.content.text ?? "") : "";
  if (!content) return null;
  return {
    id: r.memoryRecordId ?? "",
    namespace: r.namespaces?.[0] ?? namespace,
    content,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
  };
}

/**
 * Semantic search over consolidated records — the same call the parser makes before a run.
 *
 * @returns up to `topK` records ranked by relevance; `[]` when the memory is not configured.
 */
export async function retrieveRecords(
  namespace: string,
  query: string,
  topK: number,
): Promise<MemoryRecord[]> {
  const memoryId = env.knowledgeMemoryId();
  if (!memoryId) return [];
  const resp = await agentcore().send(
    new RetrieveMemoryRecordsCommand({
      memoryId,
      namespace,
      searchCriteria: { searchQuery: query, topK },
    }),
  );
  return (resp.memoryRecordSummaries ?? [])
    .map((r) => toRecord(r, namespace))
    .filter((r): r is MemoryRecord => r !== null);
}

/**
 * Every consolidated record in a namespace, newest first — what the Memory Manager panel shows.
 *
 * `ListMemoryRecords` rather than a search with a dummy query: the panel is an inventory, and a
 * search returns a relevance-ranked subset that hides whatever the query happened not to match.
 */
export async function listRecords(
  namespace: string = EDGE_CASES_NAMESPACE,
): Promise<MemoryRecord[]> {
  const memoryId = env.knowledgeMemoryId();
  if (!memoryId) return [];
  const out: MemoryRecord[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await agentcore().send(
      new ListMemoryRecordsCommand({
        memoryId,
        namespace,
        maxResults: PAGE_SIZE,
        nextToken,
      }),
    );
    for (const r of resp.memoryRecordSummaries ?? []) {
      const rec = toRecord(r, namespace);
      if (rec) out.push(rec);
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
export async function createRuleEvent(
  rule: string,
  rationale: string,
  sessionId: string,
): Promise<string | null> {
  const memoryId = env.knowledgeMemoryId();
  if (!memoryId) return null;
  const text = rationale.trim()
    ? `Deal-parsing rule: ${rule.trim()}\nRationale: ${rationale.trim()}`
    : `Deal-parsing rule: ${rule.trim()}`;
  const resp = await agentcore().send(
    new CreateEventCommand({
      memoryId,
      actorId: KNOWLEDGE_ACTOR_ID,
      sessionId: memorySafeId(sessionId),
      eventTimestamp: new Date(),
      payload: [{ conversational: { role: "USER", content: { text } } }],
    }),
  );
  return resp.event?.eventId ?? "";
}

/** Outcome of a batch delete, per record, so the panel can say which ones survived. */
export interface BatchDeleteOutcome {
  deleted: string[];
  failed: { id: string; error: string }[];
}

/**
 * Delete consolidated records by id.
 *
 * @returns per-record outcome, or null when the knowledge memory is not configured (the route turns
 *   that into a 409 rather than an empty success).
 */
export async function batchDelete(
  ids: string[],
): Promise<BatchDeleteOutcome | null> {
  const memoryId = env.knowledgeMemoryId();
  if (!memoryId) return null;
  const resp = await agentcore().send(
    new BatchDeleteMemoryRecordsCommand({
      memoryId,
      records: ids.map((id) => ({ memoryRecordId: id })),
    }),
  );
  return {
    deleted: (resp.successfulRecords ?? []).map((r) => r.memoryRecordId ?? ""),
    failed: (resp.failedRecords ?? []).map((r) => ({
      id: r.memoryRecordId ?? "",
      error: r.errorMessage ?? "unknown error",
    })),
  };
}

/**
 * The knowledge memory's strategy configuration (control plane), projected for the panel.
 *
 * Read-only by design: the strategy is owned by Terraform, and changing its `type` replaces the
 * strategy and deletes every extracted record with it.
 */
export async function getStrategy(): Promise<MemoryStrategyResponse> {
  const memoryId = env.knowledgeMemoryId();
  if (!memoryId) return { configured: false, memoryStatus: null, strategies: [] };
  const resp = await agentcoreControl().send(new GetMemoryCommand({ memoryId }));
  return {
    configured: true,
    memoryStatus: resp.memory?.status ?? null,
    strategies: (resp.memory?.strategies ?? []).map(toStrategyInfo),
  };
}

/**
 * Persist one chat turn to the short-term chat memory.
 *
 * @param actorId the verified caller's subject — sessions are private to the person who had them.
 * @returns true when written, false when the chat memory is not configured.
 */
export async function appendChatEvent(
  sessionId: string,
  role: ChatMessage["role"],
  text: string,
  actorId: string,
): Promise<boolean> {
  const memoryId = env.chatMemoryId();
  if (!memoryId || !text.trim()) return false;
  await agentcore().send(
    new CreateEventCommand({
      memoryId,
      actorId: memorySafeId(actorId),
      sessionId: memorySafeId(sessionId),
      eventTimestamp: new Date(),
      payload: [
        {
          conversational: {
            role: role === "user" ? "USER" : "ASSISTANT",
            content: { text },
          },
        },
      ],
    }),
  );
  return true;
}

/**
 * Rebuild a session's transcript from its events, oldest first.
 *
 * @returns `[]` when the chat memory is not configured or the session has no events.
 */
export async function listChatEvents(
  sessionId: string,
  actorId: string,
): Promise<ChatMessage[]> {
  const memoryId = env.chatMemoryId();
  if (!memoryId) return [];
  const out: ChatMessage[] = [];
  let nextToken: string | undefined;
  do {
    const resp = await agentcore().send(
      new ListEventsCommand({
        memoryId,
        actorId: memorySafeId(actorId),
        sessionId: memorySafeId(sessionId),
        includePayloads: true,
        maxResults: PAGE_SIZE,
        nextToken,
      }),
    );
    for (const event of resp.events ?? []) {
      const at = event.eventTimestamp
        ? new Date(event.eventTimestamp).toISOString()
        : "";
      for (const item of event.payload ?? []) {
        const turn = "conversational" in item ? item.conversational : undefined;
        const text = turn?.content && "text" in turn.content ? turn.content.text : "";
        if (!turn || !text) continue;
        out.push({
          role: turn.role === "ASSISTANT" ? "assistant" : "user",
          content: text,
          at,
        });
      }
    }
    nextToken = resp.nextToken;
  } while (nextToken);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

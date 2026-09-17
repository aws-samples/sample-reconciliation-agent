/**
 * One AgentCore Memory client for every app in the console.
 *
 * `createMemoryClient({ memoryId })` binds one memory id and returns the calls both apps make against
 * it: the semantic `retrieveRecords` the agents run before a task, the paginated `listRecords`
 * inventory a memory panel shows, `batchDelete`, the control-plane `getStrategy`, and the event
 * writes and reads (`createEvent`, `appendChatEvent`, `listChatEvents`). Each app keeps a thin
 * binding that supplies its own id and its own namespaces, actors and event text: recon in
 * `lib/reconMemory.ts` over `RECON_MEMORY_ID`; the pipeline in `lib/pipeline/server/memoryClient.ts`
 * over `KNOWLEDGE_MEMORY_ID` and `CHAT_MEMORY_ID`.
 *
 * Neutral on purpose: nothing here reads an app's environment or names an app's memory, so either
 * app can import it without depending on the other.
 *
 * An unset id is a valid deployment, not an error. Every read returns empty and every write reports
 * that nothing was written (`null` or `false`) without touching the SDK; the ROUTES decide whether a
 * no-op write is a 409 (both apps say it is — a delete that deleted nothing must not look like a
 * success). Errors are not wrapped: each route keeps its own envelope (recon answers the raw SDK
 * message, the pipeline prefixes it).
 *
 * The SDK clients are built on first use, one pair per `createMemoryClient` call, unless the caller
 * injects its own. The recon routes take the default and so build one per request, as they always
 * did; the pipeline injects its process-wide lazy clients so a route hit once a second does not
 * re-resolve the credential chain.
 *
 * Both SDK packages are imported here — the data plane for records and events, the control plane for
 * `getStrategy` — so a module that imports this one for its writes alone (recon's `lib/reconMemory.ts`,
 * and through it the cases routes) loads the control-plane package once per cold start without ever
 * calling it. Accepted as the price of one client rather than two; if it ever shows in a cold-start
 * profile, `getStrategy` is the one method to move to a sibling module.
 */

import {
  BatchDeleteMemoryRecordsCommand,
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListMemoryRecordsCommand,
  RetrieveMemoryRecordsCommand,
  type MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  BedrockAgentCoreControlClient,
  GetMemoryCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

import {
  toStrategyInfo,
  type MemoryStrategyResponse,
} from "@/lib/memoryStrategy";
import { memorySafeId } from "@/lib/server/memoryRequests";

/** One consolidated record, projected for the wire. An app may extend it (recon adds `domain`). */
export interface MemoryRecord {
  id: string;
  namespace: string;
  content: string;
  createdAt: string;
}

/** Outcome of a batch delete, per record, so a panel can say which ones survived. */
export interface BatchDeleteOutcome {
  deleted: string[];
  failed: { id: string; error: string }[];
}

/** One conversational turn read back from a memory's events. */
export interface MemoryChatTurn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/** One conversational event to write. */
export interface CreateEventInput {
  /**
   * Sent exactly as given. Reducing an id to the character set the memory API accepts is the
   * caller's job (`memorySafeId`, or an app's own rule), because the two apps disagree on what an
   * empty id should become.
   */
  actorId: string;
  sessionId: string;
  role: "USER" | "ASSISTANT";
  text: string;
}

export interface MemoryClientOptions {
  /** The memory to bind. Empty or undefined means "not configured": reads are empty, writes no-ops. */
  memoryId: string | undefined;
  /** Region for the SDK clients this call builds. Defaults to `AWS_REGION`, then `us-east-1`. */
  region?: string;
  /**
   * SDK clients to use instead of building new ones. Thunks, so an unconfigured memory never
   * constructs a client it will not call.
   */
  clients?: {
    agentcore?: () => BedrockAgentCoreClient;
    agentcoreControl?: () => BedrockAgentCoreControlClient;
  };
}

export interface MemoryClient {
  /** The bound id, or `""` when not configured. */
  readonly memoryId: string;
  /** Whether a memory id is bound. */
  readonly configured: boolean;
  /**
   * Semantic search over consolidated records — the call the agents make before a task.
   *
   * @returns up to `topK` records ranked by relevance; `[]` when not configured.
   */
  retrieveRecords(
    namespace: string,
    query: string,
    topK: number,
  ): Promise<MemoryRecord[]>;
  /**
   * Every consolidated record in a namespace, newest first — an inventory, not a search.
   *
   * @returns every record across pages; `[]` when not configured.
   */
  listRecords(namespace: string): Promise<MemoryRecord[]>;
  /**
   * Delete consolidated records by id.
   *
   * @returns the per-record outcome, or null when not configured (a route turns that into a 409
   *   rather than an empty success).
   */
  batchDelete(ids: string[]): Promise<BatchDeleteOutcome | null>;
  /**
   * The memory's strategy configuration (control plane), projected for a panel. Read-only by design:
   * the strategy is owned by Terraform, and changing its `type` replaces it and deletes every
   * extracted record with it.
   *
   * @returns `{ configured: false, memoryStatus: null, strategies: [] }` when not configured.
   */
  getStrategy(): Promise<MemoryStrategyResponse>;
  /**
   * Write one conversational event.
   *
   * @returns the event id (`""` if the service returned none), or null when not configured.
   */
  createEvent(input: CreateEventInput): Promise<string | null>;
  /**
   * Persist one chat turn, keyed on the actor so sessions stay private to the person who had them.
   * Actor and session ids are reduced to the memory API's id charset here.
   *
   * @returns true when written; false when not configured or the text is blank.
   */
  appendChatEvent(
    sessionId: string,
    role: MemoryChatTurn["role"],
    text: string,
    actorId: string,
  ): Promise<boolean>;
  /**
   * Rebuild a session's transcript from its events, oldest first.
   *
   * @returns `[]` when not configured or the session has no events.
   */
  listChatEvents(sessionId: string, actorId: string): Promise<MemoryChatTurn[]>;
}

/**
 * Records or events per page. One page is plenty for a panel; a memory with more than this many
 * records has outgrown the sample.
 */
export const MEMORY_PAGE_SIZE = 100;

const NOT_CONFIGURED: MemoryStrategyResponse = {
  configured: false,
  memoryStatus: null,
  strategies: [],
};

/** Project an SDK record summary onto the wire type, dropping records with no text. */
function toRecord(
  r: MemoryRecordSummary,
  namespace: string,
): MemoryRecord | null {
  // MemoryContent is a union member { text: ... }; both apps only ever write text.
  const content =
    r.content && "text" in r.content ? (r.content.text ?? "") : "";
  if (!content) return null;
  return {
    id: r.memoryRecordId ?? "",
    namespace: r.namespaces?.[0] ?? namespace,
    content,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
  };
}

/**
 * Bind one AgentCore Memory.
 *
 * @param options the memory id, and optionally a region or the SDK clients to use.
 * @returns the client; see `MemoryClient` for each call's contract.
 */
export function createMemoryClient(options: MemoryClientOptions): MemoryClient {
  const memoryId = options.memoryId ?? "";
  const configured = memoryId !== "";
  const region = options.region ?? process.env.AWS_REGION ?? "us-east-1";

  let dataPlane: BedrockAgentCoreClient | undefined;
  let controlPlane: BedrockAgentCoreControlClient | undefined;
  const agentcore = (): BedrockAgentCoreClient =>
    options.clients?.agentcore?.() ??
    (dataPlane ??= new BedrockAgentCoreClient({ region }));
  const agentcoreControl = (): BedrockAgentCoreControlClient =>
    options.clients?.agentcoreControl?.() ??
    (controlPlane ??= new BedrockAgentCoreControlClient({ region }));

  // A plain function rather than a method, so `appendChatEvent` reaches it without `this` — a caller
  // may destructure the client's methods.
  async function createEvent(input: CreateEventInput): Promise<string | null> {
    if (!configured) return null;
    const resp = await agentcore().send(
      new CreateEventCommand({
        memoryId,
        actorId: input.actorId,
        sessionId: input.sessionId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: input.role,
              content: { text: input.text },
            },
          },
        ],
      }),
    );
    return resp.event?.eventId ?? "";
  }

  return {
    memoryId,
    configured,

    async retrieveRecords(namespace, query, topK) {
      if (!configured) return [];
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
    },

    async listRecords(namespace) {
      if (!configured) return [];
      const out: MemoryRecord[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await agentcore().send(
          new ListMemoryRecordsCommand({
            memoryId,
            namespace,
            maxResults: MEMORY_PAGE_SIZE,
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
    },

    async batchDelete(ids) {
      if (!configured) return null;
      const resp = await agentcore().send(
        new BatchDeleteMemoryRecordsCommand({
          memoryId,
          records: ids.map((id) => ({ memoryRecordId: id })),
        }),
      );
      return {
        deleted: (resp.successfulRecords ?? []).map(
          (r) => r.memoryRecordId ?? "",
        ),
        failed: (resp.failedRecords ?? []).map((r) => ({
          id: r.memoryRecordId ?? "",
          error: r.errorMessage ?? "unknown error",
        })),
      };
    },

    async getStrategy() {
      if (!configured) return NOT_CONFIGURED;
      const resp = await agentcoreControl().send(
        new GetMemoryCommand({ memoryId }),
      );
      return {
        configured: true,
        memoryStatus: resp.memory?.status ?? null,
        strategies: (resp.memory?.strategies ?? []).map(toStrategyInfo),
      };
    },

    createEvent,

    async appendChatEvent(sessionId, role, text, actorId) {
      if (!configured || !text.trim()) return false;
      await createEvent({
        actorId: memorySafeId(actorId),
        sessionId: memorySafeId(sessionId),
        role: role === "user" ? "USER" : "ASSISTANT",
        text,
      });
      return true;
    },

    async listChatEvents(sessionId, actorId) {
      if (!configured) return [];
      const out: MemoryChatTurn[] = [];
      let nextToken: string | undefined;
      do {
        const resp = await agentcore().send(
          new ListEventsCommand({
            memoryId,
            actorId: memorySafeId(actorId),
            sessionId: memorySafeId(sessionId),
            includePayloads: true,
            maxResults: MEMORY_PAGE_SIZE,
            nextToken,
          }),
        );
        for (const event of resp.events ?? []) {
          const at = event.eventTimestamp
            ? new Date(event.eventTimestamp).toISOString()
            : "";
          for (const item of event.payload ?? []) {
            const turn =
              "conversational" in item ? item.conversational : undefined;
            const text =
              turn?.content && "text" in turn.content ? turn.content.text : "";
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
    },
  };
}

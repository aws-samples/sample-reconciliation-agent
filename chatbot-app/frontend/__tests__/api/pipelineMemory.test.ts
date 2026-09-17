// @vitest-environment node
/**
 * `/api/pipeline/memory` and `/memory/strategy` — the Memory Manager.
 *
 * Two contracts to pin. An unconfigured memory is a valid deployment: reads answer `[]` and
 * "not configured", never an error; writes answer 409, because a delete or add that reached no
 * memory must not look like a success. And the panel lists with `ListMemoryRecords`, not a search
 * — an inventory, not a relevance-ranked subset.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { agentCoreControlModule, agentCoreModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { admitted, refused } from "../helpers/gates";
import { jsonRequest } from "../helpers/http";

const env = scopedEnv(["KNOWLEDGE_MEMORY_ID", "CHAT_MEMORY_ID"], { AWS_REGION: "us-east-1" });
afterAll(() => env.restore());

const agentcoreSend = vi.fn();
const controlSend = vi.fn();
const requireActor = vi.fn();
const requireAppAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppAdmin }));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => agentCoreModule(agentcoreSend));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => agentCoreControlModule(controlSend));

const memory = await import("@/app/api/pipeline/memory/route");
const strategy = await import("@/app/api/pipeline/memory/strategy/route");
const client = await import("@/lib/pipeline/server/memoryClient");
const { parseMemoryDeleteIds } = await import("@/lib/server/memoryRequests");

const MEMORY_ID = "deal_pipeline_test_knowledge-abc123";

const req = (method: string, body?: unknown) => jsonRequest(method, "http://x/api/pipeline/memory", body);

beforeEach(() => {
  vi.clearAllMocks();
  env.set({ KNOWLEDGE_MEMORY_ID: MEMORY_ID });
  requireActor.mockResolvedValue(admitted("reviewer"));
  requireAppAdmin.mockResolvedValue(admitted("admin-1"));
});

describe("with no knowledge memory configured", () => {
  beforeEach(() => {
    env.set({ KNOWLEDGE_MEMORY_ID: "" });
  });

  it("GET answers an empty list without calling AgentCore", async () => {
    const resp = await memory.GET(req("GET"));
    expect(await resp.json()).toEqual([]);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("DELETE and POST refuse with 409 naming the variable", async () => {
    const del = await memory.DELETE(req("DELETE", { ids: ["rec-1"] }));
    expect(del.status).toBe(409);
    expect((await del.json()).error).toMatch(/KNOWLEDGE_MEMORY_ID/);
    const post = await memory.POST(req("POST", { rule: "Project-finance TLBs are First Lien." }));
    expect(post.status).toBe(409);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("strategy GET reports configured: false", async () => {
    const resp = await strategy.GET(req("GET"));
    expect(await resp.json()).toEqual({ configured: false, memoryStatus: null, strategies: [] });
    expect(controlSend).not.toHaveBeenCalled();
  });
});

describe("GET /api/pipeline/memory", () => {
  it("lists consolidated records from the edge-cases namespace, newest first, across pages", async () => {
    agentcoreSend
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          {
            memoryRecordId: "rec-old",
            content: { text: "Project-finance term loans are First Lien in the OMS." },
            namespaces: ["deal-pipeline/edge-cases/deal-desk"],
            createdAt: new Date("2026-08-10T00:00:00Z"),
          },
          { memoryRecordId: "rec-blank", content: { text: "" }, createdAt: new Date() },
        ],
        nextToken: "page-2",
      })
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          {
            memoryRecordId: "rec-new",
            content: { text: "Add-on facilities carry New Money equal to Issue Size." },
            createdAt: new Date("2026-08-12T00:00:00Z"),
          },
        ],
      });
    const body = await (await memory.GET(req("GET"))).json();
    expect(body.map((r: { id: string }) => r.id)).toEqual(["rec-new", "rec-old"]);
    expect(body[1]).toEqual({
      id: "rec-old",
      namespace: "deal-pipeline/edge-cases/deal-desk",
      content: "Project-finance term loans are First Lien in the OMS.",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "ListRecords",
      memoryId: MEMORY_ID,
      namespace: "deal-pipeline/edge-cases/deal-desk",
    });
    expect(agentcoreSend.mock.calls[1][0]).toMatchObject({ nextToken: "page-2" });
  });
});

describe("POST /api/pipeline/memory", () => {
  it("writes a USER event for the desk actor and answers 202 with the event id", async () => {
    agentcoreSend.mockResolvedValue({ event: { eventId: "evt-1" } });
    const resp = await memory.POST(
      req("POST", {
        rule: "Project-finance term loans are First Lien in the OMS.",
        rationale: "PROJECT_FINANCE_LIEN rejected the pipeline deal.",
      }),
    );
    expect(resp.status).toBe(202);
    expect(await resp.json()).toEqual({ event_id: "evt-1" });
    const cmd = agentcoreSend.mock.calls[0][0];
    expect(cmd).toMatchObject({ __cmd: "CreateEvent", memoryId: MEMORY_ID, actorId: "deal-desk" });
    expect(cmd.sessionId).toMatch(/^manual-/);
    expect(cmd.payload[0].conversational.role).toBe("USER");
    expect(cmd.payload[0].conversational.content.text).toContain("First Lien");
    expect(cmd.payload[0].conversational.content.text).toContain("PROJECT_FINANCE_LIEN");
  });

  it("requires a rule and honours the admin gate", async () => {
    expect((await memory.POST(req("POST", {}))).status).toBe(400);
    requireAppAdmin.mockResolvedValue(refused(403, "not an admin"));
    expect((await memory.POST(req("POST", { rule: "x" }))).status).toBe(403);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/pipeline/memory", () => {
  it("deletes the selected records and reports per-record outcome", async () => {
    agentcoreSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: "rec-1" }],
      failedRecords: [{ memoryRecordId: "rec-2", errorMessage: "record not found" }],
    });
    const resp = await memory.DELETE(req("DELETE", { ids: ["rec-1", "rec-2", "rec-1"] }));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      deleted: ["rec-1"],
      failed: [{ id: "rec-2", error: "record not found" }],
    });
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "BatchDelete",
      memoryId: MEMORY_ID,
      records: [{ memoryRecordId: "rec-1" }, { memoryRecordId: "rec-2" }],
    });
  });

  it("400s a bad body and deletes nothing", async () => {
    expect((await memory.DELETE(req("DELETE", { ids: [] }))).status).toBe(400);
    expect((await memory.DELETE(req("DELETE", { ids: ["a", 7] }))).status).toBe(400);
    expect(agentcoreSend).not.toHaveBeenCalled();
  });

  it("refuses more ids than the cap instead of trimming", () => {
    const ids = Array.from({ length: 51 }, (_, i) => `id-${i}`);
    expect(() => parseMemoryDeleteIds({ ids })).toThrow(/at most 50/);
    expect(parseMemoryDeleteIds({ ids: ["a", " b ", "a"] })).toEqual(["a", "b"]);
  });
});

describe("GET /api/pipeline/memory/strategy", () => {
  it("projects the live strategy", async () => {
    controlSend.mockResolvedValue({
      memory: {
        status: "ACTIVE",
        strategies: [
          {
            strategyId: "str-1",
            name: "edge_cases",
            type: "CUSTOM",
            status: "ACTIVE",
            namespaces: ["deal-pipeline/edge-cases/{actorId}"],
            configuration: {
              type: "SEMANTIC_OVERRIDE",
              extraction: {
                customExtractionConfiguration: {
                  semanticExtractionOverride: {
                    appendToPrompt: "Extract reusable deal-parsing rules…",
                    modelId: "us.anthropic.claude-sonnet-5",
                  },
                },
              },
            },
          },
        ],
      },
    });
    const body = await (await strategy.GET(req("GET"))).json();
    expect(body.configured).toBe(true);
    expect(body.memoryStatus).toBe("ACTIVE");
    expect(body.strategies[0]).toMatchObject({
      name: "edge_cases",
      configurationType: "SEMANTIC_OVERRIDE",
      namespaces: ["deal-pipeline/edge-cases/{actorId}"],
      extraction: { kind: "semanticExtractionOverride", modelId: "us.anthropic.claude-sonnet-5" },
      consolidation: null,
    });
    expect(controlSend.mock.calls[0][0]).toMatchObject({ __cmd: "GetMemory", memoryId: MEMORY_ID });
  });
});

describe("memoryClient", () => {
  it("retrieveRecords runs the same semantic search the parser uses", async () => {
    agentcoreSend.mockResolvedValue({
      memoryRecordSummaries: [{ memoryRecordId: "r", content: { text: "rule" }, createdAt: new Date(0) }],
    });
    const out = await client.retrieveRecords(client.EDGE_CASES_NAMESPACE, "project finance TLB", 6);
    expect(out).toHaveLength(1);
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Retrieve",
      namespace: "deal-pipeline/edge-cases/deal-desk",
      searchCriteria: { searchQuery: "project finance TLB", topK: 6 },
    });
  });

  it("chat events are no-ops without CHAT_MEMORY_ID and keyed on the actor with it", async () => {
    env.set({ CHAT_MEMORY_ID: "" });
    expect(await client.appendChatEvent("s1", "user", "hi", "sub-1")).toBe(false);
    expect(await client.listChatEvents("s1", "sub-1")).toEqual([]);
    expect(agentcoreSend).not.toHaveBeenCalled();

    env.set({ CHAT_MEMORY_ID: "chat-mem" });
    agentcoreSend.mockResolvedValueOnce({ event: { eventId: "e1" } });
    expect(await client.appendChatEvent("s1", "assistant", "hello", "user@example.test")).toBe(true);
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({
      __cmd: "CreateEvent",
      memoryId: "chat-mem",
      actorId: "user-example-test",
      sessionId: "s1",
    });
    expect(agentcoreSend.mock.calls[0][0].payload[0].conversational.role).toBe("ASSISTANT");

    agentcoreSend.mockResolvedValueOnce({
      events: [
        {
          eventTimestamp: new Date("2026-08-13T10:01:00Z"),
          payload: [{ conversational: { role: "ASSISTANT", content: { text: "hello" } } }],
        },
        {
          eventTimestamp: new Date("2026-08-13T10:00:00Z"),
          payload: [{ conversational: { role: "USER", content: { text: "hi" } } }],
        },
      ],
    });
    const transcript = await client.listChatEvents("s1", "user@example.test");
    expect(transcript.map((m) => `${m.role}:${m.content}`)).toEqual(["user:hi", "assistant:hello"]);
    expect(agentcoreSend.mock.calls[1][0]).toMatchObject({
      __cmd: "ListEvents",
      includePayloads: true,
      actorId: "user-example-test",
    });
  });
});

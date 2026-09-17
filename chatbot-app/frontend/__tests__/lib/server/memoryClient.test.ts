// @vitest-environment node
/**
 * `createMemoryClient` — the one AgentCore Memory client both apps bind.
 *
 * What is pinned: an unset id makes every read empty and every write a reported no-op without an SDK
 * client ever being built; the SDK clients are otherwise built once per client, on first use, in the
 * given region, or taken from the caller; and each call's projection is the shape both apps' routes
 * and the parser already depend on. `createEvent` sends actor and session ids exactly as given — the
 * two apps sanitise differently, and the client must not choose for them — while the chat helpers
 * reduce OIDC subjects and session ids to the memory API's charset themselves.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentCoreControlModule,
  agentCoreModule,
} from "../../helpers/awsMocks";
import { scopedEnv } from "../../helpers/env";

const env = scopedEnv(["AWS_REGION"]);
afterAll(() => env.restore());

const dataSend = vi.fn();
const controlSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock-agentcore", () => agentCoreModule(dataSend));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () =>
  agentCoreControlModule(controlSend),
);

const { createMemoryClient } = await import("@/lib/server/memoryClient");
const { BedrockAgentCoreClient } =
  await import("@aws-sdk/client-bedrock-agentcore");
const { BedrockAgentCoreControlClient } =
  await import("@aws-sdk/client-bedrock-agentcore-control");

const MEMORY_ID = "shared_test_memory-abc123";
const NAMESPACE = "reconciliation/lessons/lending";

beforeEach(() => {
  vi.clearAllMocks();
  env.clear();
});

describe("createMemoryClient", () => {
  it("with no id, reads empty and writes nothing without building an SDK client", async () => {
    const client = createMemoryClient({ memoryId: "" });
    expect(client.configured).toBe(false);
    expect(client.memoryId).toBe("");

    expect(await client.retrieveRecords(NAMESPACE, "lending", 25)).toEqual([]);
    expect(await client.listRecords(NAMESPACE)).toEqual([]);
    expect(await client.batchDelete(["rec-1"])).toBeNull();
    expect(await client.getStrategy()).toEqual({
      configured: false,
      memoryStatus: null,
      strategies: [],
    });
    expect(
      await client.createEvent({
        actorId: "lending",
        sessionId: "lesson-1",
        role: "USER",
        text: "x",
      }),
    ).toBeNull();
    expect(await client.appendChatEvent("s1", "user", "hi", "sub-1")).toBe(
      false,
    );
    expect(await client.listChatEvents("s1", "sub-1")).toEqual([]);

    expect(dataSend).not.toHaveBeenCalled();
    expect(controlSend).not.toHaveBeenCalled();
    expect(BedrockAgentCoreClient).not.toHaveBeenCalled();
    expect(BedrockAgentCoreControlClient).not.toHaveBeenCalled();

    // `undefined` is the same as unset.
    expect(createMemoryClient({ memoryId: undefined }).configured).toBe(false);
  });

  it("builds its SDK clients on first use, once each, in the given region", async () => {
    dataSend.mockResolvedValue({ memoryRecordSummaries: [] });
    controlSend.mockResolvedValue({ memory: { status: "ACTIVE" } });
    const client = createMemoryClient({
      memoryId: MEMORY_ID,
      region: "eu-west-1",
    });
    expect(BedrockAgentCoreClient).not.toHaveBeenCalled();

    await client.retrieveRecords(NAMESPACE, "lending", 25);
    await client.retrieveRecords(NAMESPACE, "lending", 25);
    expect(BedrockAgentCoreClient).toHaveBeenCalledTimes(1);
    expect(BedrockAgentCoreClient).toHaveBeenCalledWith({
      region: "eu-west-1",
    });
    expect(BedrockAgentCoreControlClient).not.toHaveBeenCalled();

    await client.getStrategy();
    await client.getStrategy();
    expect(BedrockAgentCoreControlClient).toHaveBeenCalledTimes(1);
    expect(BedrockAgentCoreControlClient).toHaveBeenCalledWith({
      region: "eu-west-1",
    });

    // A second client builds its own — one pair per createMemoryClient call.
    await createMemoryClient({
      memoryId: MEMORY_ID,
      region: "eu-west-1",
    }).listRecords(NAMESPACE);
    expect(BedrockAgentCoreClient).toHaveBeenCalledTimes(2);
  });

  it("defaults the region to AWS_REGION, then us-east-1", async () => {
    dataSend.mockResolvedValue({ memoryRecordSummaries: [] });
    await createMemoryClient({ memoryId: MEMORY_ID }).listRecords(NAMESPACE);
    expect(BedrockAgentCoreClient).toHaveBeenLastCalledWith({
      region: "us-east-1",
    });

    env.set({ AWS_REGION: "ap-southeast-2" });
    await createMemoryClient({ memoryId: MEMORY_ID }).listRecords(NAMESPACE);
    expect(BedrockAgentCoreClient).toHaveBeenLastCalledWith({
      region: "ap-southeast-2",
    });
  });

  it("uses injected clients instead of building its own", async () => {
    const injectedData = vi
      .fn()
      .mockResolvedValue({ memoryRecordSummaries: [] });
    const injectedControl = vi.fn().mockResolvedValue({ memory: {} });
    const client = createMemoryClient({
      memoryId: MEMORY_ID,
      clients: {
        agentcore: () =>
          ({ send: injectedData }) as unknown as InstanceType<
            typeof BedrockAgentCoreClient
          >,
        agentcoreControl: () =>
          ({ send: injectedControl }) as unknown as InstanceType<
            typeof BedrockAgentCoreControlClient
          >,
      },
    });
    await client.listRecords(NAMESPACE);
    await client.getStrategy();
    expect(injectedData).toHaveBeenCalledTimes(1);
    expect(injectedControl).toHaveBeenCalledTimes(1);
    expect(BedrockAgentCoreClient).not.toHaveBeenCalled();
    expect(BedrockAgentCoreControlClient).not.toHaveBeenCalled();
  });

  it("retrieveRecords runs a semantic search and projects the summaries, dropping blank text", async () => {
    dataSend.mockResolvedValue({
      memoryRecordSummaries: [
        {
          memoryRecordId: "rec-1",
          content: { text: "Paydown breaks under 1 USD are rounding." },
          namespaces: ["reconciliation/lessons/lending"],
          createdAt: new Date("2026-08-10T00:00:00Z"),
        },
        // No namespaces on the summary: the requested one is used.
        {
          memoryRecordId: "rec-2",
          content: { text: "Day-count basis explains accrual differences." },
        },
        { memoryRecordId: "rec-blank", content: { text: "" } },
      ],
    });
    const out = await createMemoryClient({
      memoryId: MEMORY_ID,
    }).retrieveRecords(NAMESPACE, "lending", 25);
    expect(out).toEqual([
      {
        id: "rec-1",
        namespace: "reconciliation/lessons/lending",
        content: "Paydown breaks under 1 USD are rounding.",
        createdAt: "2026-08-10T00:00:00.000Z",
      },
      {
        id: "rec-2",
        namespace: NAMESPACE,
        content: "Day-count basis explains accrual differences.",
        createdAt: "",
      },
    ]);
    expect(dataSend.mock.calls[0][0]).toEqual({
      __cmd: "Retrieve",
      memoryId: MEMORY_ID,
      namespace: NAMESPACE,
      searchCriteria: { searchQuery: "lending", topK: 25 },
    });
  });

  it("listRecords walks every page and answers newest first", async () => {
    dataSend
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          {
            memoryRecordId: "rec-old",
            content: { text: "older" },
            createdAt: new Date("2026-08-10T00:00:00Z"),
          },
        ],
        nextToken: "page-2",
      })
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          {
            memoryRecordId: "rec-new",
            content: { text: "newer" },
            createdAt: new Date("2026-08-12T00:00:00Z"),
          },
        ],
      });
    const out = await createMemoryClient({ memoryId: MEMORY_ID }).listRecords(
      NAMESPACE,
    );
    expect(out.map((r) => r.id)).toEqual(["rec-new", "rec-old"]);
    expect(dataSend.mock.calls[0][0]).toMatchObject({
      __cmd: "ListRecords",
      memoryId: MEMORY_ID,
      namespace: NAMESPACE,
      maxResults: 100,
    });
    expect(dataSend.mock.calls[1][0]).toMatchObject({ nextToken: "page-2" });
  });

  it("batchDelete reports the outcome per record", async () => {
    dataSend.mockResolvedValue({
      successfulRecords: [{ memoryRecordId: "rec-1" }],
      failedRecords: [
        { memoryRecordId: "rec-2", errorMessage: "record not found" },
        { memoryRecordId: "rec-3" },
      ],
    });
    const out = await createMemoryClient({ memoryId: MEMORY_ID }).batchDelete([
      "rec-1",
      "rec-2",
      "rec-3",
    ]);
    expect(out).toEqual({
      deleted: ["rec-1"],
      failed: [
        { id: "rec-2", error: "record not found" },
        { id: "rec-3", error: "unknown error" },
      ],
    });
    expect(dataSend.mock.calls[0][0]).toEqual({
      __cmd: "BatchDelete",
      memoryId: MEMORY_ID,
      records: [
        { memoryRecordId: "rec-1" },
        { memoryRecordId: "rec-2" },
        { memoryRecordId: "rec-3" },
      ],
    });
  });

  it("getStrategy projects GetMemory through the shared strategy flattener", async () => {
    controlSend.mockResolvedValue({
      memory: {
        status: "ACTIVE",
        strategies: [
          {
            strategyId: "str-1",
            name: "lessons_learned",
            type: "CUSTOM",
            status: "ACTIVE",
            namespaces: ["reconciliation/lessons/{actorId}"],
            configuration: {
              type: "SEMANTIC_OVERRIDE",
              extraction: {
                customExtractionConfiguration: {
                  semanticExtractionOverride: {
                    appendToPrompt: "Extract lessons…",
                    modelId: "us.anthropic.claude-sonnet-5",
                  },
                },
              },
            },
          },
        ],
      },
    });
    const out = await createMemoryClient({ memoryId: MEMORY_ID }).getStrategy();
    expect(out.configured).toBe(true);
    expect(out.memoryStatus).toBe("ACTIVE");
    expect(out.strategies[0]).toMatchObject({
      id: "str-1",
      name: "lessons_learned",
      configurationType: "SEMANTIC_OVERRIDE",
      extraction: {
        kind: "semanticExtractionOverride",
        appendToPrompt: "Extract lessons…",
      },
      consolidation: null,
    });
    expect(controlSend.mock.calls[0][0]).toEqual({
      __cmd: "GetMemory",
      memoryId: MEMORY_ID,
    });

    controlSend.mockResolvedValue({ memory: { status: "ACTIVE" } });
    expect(
      await createMemoryClient({ memoryId: MEMORY_ID }).getStrategy(),
    ).toEqual({
      configured: true,
      memoryStatus: "ACTIVE",
      strategies: [],
    });
  });

  it("createEvent sends the ids exactly as given and answers the event id", async () => {
    dataSend.mockResolvedValueOnce({ event: { eventId: "evt-1" } });
    const client = createMemoryClient({ memoryId: MEMORY_ID });
    const id = await client.createEvent({
      // Not a legal memory id — and not this client's problem: the caller sanitises.
      actorId: "loan ops#1",
      sessionId: "lesson-IT 1",
      role: "USER",
      text: "Analyst decision…",
    });
    expect(id).toBe("evt-1");
    const cmd = dataSend.mock.calls[0][0];
    expect(cmd).toMatchObject({
      __cmd: "CreateEvent",
      memoryId: MEMORY_ID,
      actorId: "loan ops#1",
      sessionId: "lesson-IT 1",
      payload: [
        {
          conversational: {
            role: "USER",
            content: { text: "Analyst decision…" },
          },
        },
      ],
    });
    expect(cmd.eventTimestamp).toBeInstanceOf(Date);

    // A response with no event id is still a write: `""`, not null.
    dataSend.mockResolvedValueOnce({});
    expect(
      await client.createEvent({
        actorId: "a",
        sessionId: "s",
        role: "ASSISTANT",
        text: "t",
      }),
    ).toBe("");
  });

  it("works with its methods detached from the client", async () => {
    // `appendChatEvent` writes through `createEvent`; neither may depend on `this`, because a binding
    // module is free to pick the methods it re-exports off the client.
    const { appendChatEvent, createEvent } = createMemoryClient({
      memoryId: MEMORY_ID,
    });
    dataSend.mockResolvedValue({ event: { eventId: "e1" } });
    expect(await appendChatEvent("s1", "user", "hi", "sub-1")).toBe(true);
    expect(
      await createEvent({
        actorId: "lending",
        sessionId: "lesson-1",
        role: "USER",
        text: "x",
      }),
    ).toBe("e1");
    expect(dataSend).toHaveBeenCalledTimes(2);
  });

  it("chat events reduce actor and session ids to the memory charset and read back oldest first", async () => {
    const client = createMemoryClient({ memoryId: MEMORY_ID });

    // A blank turn is not written.
    expect(await client.appendChatEvent("s1", "user", "   ", "sub-1")).toBe(
      false,
    );
    expect(dataSend).not.toHaveBeenCalled();

    dataSend.mockResolvedValueOnce({ event: { eventId: "e1" } });
    expect(
      await client.appendChatEvent(
        "s1",
        "assistant",
        "hello",
        "user@example.test",
      ),
    ).toBe(true);
    expect(dataSend.mock.calls[0][0]).toMatchObject({
      __cmd: "CreateEvent",
      memoryId: MEMORY_ID,
      actorId: "user-example-test",
      sessionId: "s1",
    });
    expect(dataSend.mock.calls[0][0].payload[0].conversational.role).toBe(
      "ASSISTANT",
    );

    dataSend.mockResolvedValueOnce({
      events: [
        {
          eventTimestamp: new Date("2026-08-13T10:01:00Z"),
          payload: [
            {
              conversational: { role: "ASSISTANT", content: { text: "hello" } },
            },
          ],
        },
        {
          eventTimestamp: new Date("2026-08-13T10:00:00Z"),
          payload: [
            { conversational: { role: "USER", content: { text: "hi" } } },
          ],
        },
      ],
    });
    const transcript = await client.listChatEvents("s1", "user@example.test");
    expect(transcript).toEqual([
      { role: "user", content: "hi", at: "2026-08-13T10:00:00.000Z" },
      { role: "assistant", content: "hello", at: "2026-08-13T10:01:00.000Z" },
    ]);
    expect(dataSend.mock.calls[1][0]).toMatchObject({
      __cmd: "ListEvents",
      memoryId: MEMORY_ID,
      includePayloads: true,
      actorId: "user-example-test",
      sessionId: "s1",
      maxResults: 100,
    });
  });
});

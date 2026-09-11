// @vitest-environment node
/**
 * `POST /api/pipeline/chat` — the assistant's SSE stream — driven by a scripted ConverseStream.
 *
 * The protocol is what the UI renders, so the assertions are about the exact frame sequence for a
 * turn with one tool call: the model asks for `get_deal`, the route emits `tool_call`, runs it, emits
 * a one-line `tool_result`, feeds the result back as a `toolResult` block, streams the final text,
 * and ends with `done`. The turn is also persisted to chat memory as one USER and one ASSISTANT event.
 *
 * The other contract pinned here is the admin gate on the memory-writing tools. `POST` and `DELETE
 * /memory` are admin-only; the assistant's `save_memory` and `delete_memory` are the same writes, so
 * a non-admin session must neither be offered them nor be able to run one the model calls anyway.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

process.env.AWS_REGION = "us-east-1";
process.env.ASSETS_BUCKET = "test-assets";
process.env.DEALS_TABLE = "test-deals";
process.env.EMAILS_TABLE = "test-emails";
process.env.SKILL_PROPOSALS_TABLE = "test-proposals";
process.env.CHAT_MEMORY_ID = "deal_pipeline_test_chat-xyz";
process.env.KNOWLEDGE_MEMORY_ID = "";
process.env.ASSISTANT_MODEL_ID = "us.anthropic.claude-sonnet-5";

const ddbSend = vi.fn();
const s3Send = vi.fn();
const bedrockSend = vi.fn();
const agentcoreSend = vi.fn();
const requireActor = vi.fn();
const requirePipelineActor = vi.fn();

// The history route names the actor only; the chat route also needs the admin flag.
vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/pipelineAdmin", () => ({ requirePipelineActor }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetItem", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutItem", ...i })),
  ScanCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Scan", ...i })),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetObject", ...i })),
  PutObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutObject", ...i })),
  ListObjectsV2Command: vi.fn().mockImplementation((i) => ({ __cmd: "List", ...i })),
  DeleteObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Delete", ...i })),
}));
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: bedrockSend })),
  ConverseStreamCommand: vi.fn().mockImplementation((i) => ({ __cmd: "ConverseStream", ...i })),
}));
vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send: agentcoreSend })),
  RetrieveMemoryRecordsCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Retrieve", ...i })),
  ListMemoryRecordsCommand: vi.fn().mockImplementation((i) => ({ __cmd: "ListRecords", ...i })),
  BatchDeleteMemoryRecordsCommand: vi.fn().mockImplementation((i) => ({ __cmd: "BatchDelete", ...i })),
  CreateEventCommand: vi.fn().mockImplementation((i) => ({ __cmd: "CreateEvent", ...i })),
  ListEventsCommand: vi.fn().mockImplementation((i) => ({ __cmd: "ListEvents", ...i })),
}));

const chat = await import("@/app/api/pipeline/chat/route");
const history = await import("@/app/api/pipeline/chat/history/route");
const agent = await import("@/lib/pipeline/server/chatAgent");
const { emptyFields } = await import("@/lib/pipeline/omsSchema");
type DealRecord = import("@/lib/pipeline/types").DealRecord;
type ChatStreamEvent = import("@/lib/pipeline/types").ChatStreamEvent;

const DEAL: DealRecord = {
  deal_id: "dl_1",
  email_id: "em_1",
  opportunity_name: "Copperfield Insurance refinancing TLB",
  status: "UPLOAD_FAILED",
  fields: { ...emptyFields(), opportunity_name: "Copperfield Insurance refinancing TLB" },
  original_fields: emptyFields(),
  evidence: {},
  assumptions: [],
  memory_hits: [],
  skills_used: ["deal-parsing"],
  enrichment: { issuer_match: null, fields_from_security_master: [] },
  csv_key: "deal-csv/dl_1.csv",
  upload: {
    attempted_at: "2026-08-13T10:05:00Z",
    accepted: false,
    staging_key: null,
    errors: [{ code: "COVENANT_STATUS_REQUIRED", field: "covenant_status_num", message: "m" }],
    validator_version: "1",
  },
  history: [],
  created_at: "2026-08-13T10:00:00Z",
  updated_at: "2026-08-13T10:05:00Z",
};

/** Build an async iterable from scripted ConverseStream events. */
async function* scripted(events: object[]) {
  for (const e of events) yield e;
}
const toolRound = (toolUseId: string, name: string, input: object) =>
  scripted([
    { messageStart: { role: "assistant" } },
    { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId, name } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(input).slice(0, 8) } } } },
    { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(input).slice(8) } } } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
  ]);
const textRound = (...deltas: string[]) =>
  scripted([
    { messageStart: { role: "assistant" } },
    ...deltas.map((text) => ({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } })),
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "end_turn" } },
  ]);

/** Parse an SSE body into its `data:` events (comments are dropped). */
async function readFrames(resp: Response): Promise<{ events: ChatStreamEvent[]; raw: string }> {
  const raw = await resp.text();
  const events = raw
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice("data: ".length)) as ChatStreamEvent);
  return { events, raw };
}

function post(body: unknown) {
  return chat.POST(
    new Request("http://x/api/pipeline/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.KNOWLEDGE_MEMORY_ID = "";
  requireActor.mockResolvedValue({ actor: "user@example.test" });
  requirePipelineActor.mockResolvedValue({ actor: "user@example.test", isAdmin: true });
  // No seeded assistant prompt → built-in prompt; deal lookups hit the fake table below.
  s3Send.mockRejectedValue(Object.assign(new Error("nsk"), { name: "NoSuchKey" }));
  ddbSend.mockImplementation(async (cmd: { __cmd: string; Key?: never }) => {
    if (cmd.__cmd === "GetItem" && unmarshall(cmd.Key!).deal_id === "dl_1") return { Item: marshall(DEAL) };
    if (cmd.__cmd === "GetItem") return {};
    if (cmd.__cmd === "Scan") return { Items: [marshall(DEAL)] };
    return {};
  });
  // Chat memory: empty history, successful event writes.
  agentcoreSend.mockImplementation(async (cmd: { __cmd: string }) =>
    cmd.__cmd === "ListEvents" ? { events: [] } : { event: { eventId: "evt" } },
  );
});

describe("POST /api/pipeline/chat", () => {
  it("streams text, one tool call and its result, then done — and feeds the result back to the model", async () => {
    bedrockSend
      .mockResolvedValueOnce({ stream: toolRound("tu-1", "get_deal", { deal_id: "dl_1" }) })
      .mockResolvedValueOnce({ stream: textRound("The upload failed because ", "Covenant Status # is blank.") });

    const resp = await post({
      session_id: "sess-1",
      message: "Why did the Copperfield upload fail?",
      context: { deal_id: "dl_1" },
    });
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const { events, raw } = await readFrames(resp);
    expect(raw.startsWith(": connected")).toBe(true);
    expect(events).toEqual([
      { type: "tool_call", name: "get_deal", input: { deal_id: "dl_1" } },
      {
        type: "tool_result",
        name: "get_deal",
        ok: true,
        summary: "dl_1 Copperfield Insurance refinancing TLB [UPLOAD_FAILED; upload rejected: COVENANT_STATUS_REQUIRED]",
      },
      { type: "text", delta: "The upload failed because " },
      { type: "text", delta: "Covenant Status # is blank." },
      { type: "done", session_id: "sess-1" },
    ]);

    // First call: system prompt + context note, tools, the user message.
    const first = bedrockSend.mock.calls[0][0];
    expect(first.modelId).toBe("us.anthropic.claude-sonnet-5");
    expect(first.system[0].text).toBe(agent.DEFAULT_SYSTEM_PROMPT);
    expect(first.system[1].text).toContain("deal dl_1");
    expect(first.system).toHaveLength(2); // an admin session gets no role note
    expect(first.toolConfig.tools.map((t: { toolSpec: { name: string } }) => t.toolSpec.name)).toEqual([
      "list_deals", "get_deal", "get_email", "list_skills", "get_skill", "list_counterparties",
      "propose_skill_update", "list_memories", "save_memory", "delete_memory",
    ]);
    // The loop appends to one messages array across rounds, so only the head is fixed here; the
    // full second-round shape is asserted below.
    expect(first.messages[0]).toEqual({
      role: "user",
      content: [{ text: "Why did the Copperfield upload fail?" }],
    });

    // Second call: the assistant's toolUse replayed, then the toolResult for the same toolUseId.
    const second = bedrockSend.mock.calls[1][0];
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [{ toolUse: { toolUseId: "tu-1", name: "get_deal", input: { deal_id: "dl_1" } } }],
    });
    expect(second.messages[2].role).toBe("user");
    expect(second.messages[2].content[0].toolResult).toMatchObject({ toolUseId: "tu-1", status: "success" });
    expect(second.messages[2].content[0].toolResult.content[0].json.deal.deal_id).toBe("dl_1");

    // Both turns persisted to the chat memory under the caller's subject.
    const writes = agentcoreSend.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === "CreateEvent");
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      memoryId: "deal_pipeline_test_chat-xyz",
      actorId: "user-example-test",
      sessionId: "sess-1",
    });
    expect(writes[0].payload[0].conversational).toEqual({
      role: "USER",
      content: { text: "Why did the Copperfield upload fail?" },
    });
    expect(writes[1].payload[0].conversational).toEqual({
      role: "ASSISTANT",
      content: { text: "The upload failed because Covenant Status # is blank." },
    });
  });

  it("reports a failed tool to the model as an error result and keeps streaming", async () => {
    bedrockSend
      .mockResolvedValueOnce({ stream: toolRound("tu-2", "get_deal", { deal_id: "dl_missing" }) })
      .mockResolvedValueOnce({ stream: textRound("I could not find that deal.") });
    const { events } = await readFrames(await post({ session_id: "s", message: "look at dl_missing" }));
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "get_deal",
      ok: false,
      summary: "dl_missing not found",
    });
    expect(bedrockSend.mock.calls[1][0].messages[2].content[0].toolResult.status).toBe("error");
    expect(events[events.length - 1]).toEqual({ type: "done", session_id: "s" });
  });

  it("emits an error frame (then done) when the model call fails", async () => {
    bedrockSend.mockRejectedValueOnce(new Error("ThrottlingException"));
    const { events } = await readFrames(await post({ session_id: "s", message: "hi" }));
    expect(events).toEqual([
      { type: "error", message: "ThrottlingException" },
      { type: "done", session_id: "s" },
    ]);
  });

  it("stops after the round cap when the model never answers", async () => {
    bedrockSend.mockImplementation(async () => ({ stream: toolRound("tu", "list_deals", {}) }));
    const { events } = await readFrames(await post({ session_id: "s", message: "loop" }));
    expect(bedrockSend).toHaveBeenCalledTimes(agent.MAX_TOOL_ROUNDS);
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(agent.MAX_TOOL_ROUNDS);
    expect(events[events.length - 2]).toMatchObject({ type: "error" });
  });

  it("surfaces a max_tokens truncation as an error instead of running a half-formed tool call", async () => {
    // The model started a propose_skill_update call but the output cap cut its JSON in half.
    bedrockSend.mockResolvedValueOnce({
      stream: scripted([
        { messageStart: { role: "assistant" } },
        { contentBlockStart: { contentBlockIndex: 0, start: { toolUse: { toolUseId: "tu", name: "propose_skill_update" } } } },
        { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{"skill_name":"deal-parsing","edits":[{"find":"x","rep' } } } },
        { messageStop: { stopReason: "max_tokens" } },
      ]),
    });
    const { events } = await readFrames(await post({ session_id: "s", message: "propose" }));
    expect(events.filter((e) => e.type === "tool_call")).toHaveLength(0);
    expect(events[0]).toMatchObject({ type: "error", message: expect.stringContaining("output limit") });
    expect(events[events.length - 1]).toEqual({ type: "done", session_id: "s" });
    expect(bedrockSend).toHaveBeenCalledTimes(1);
  });

  it("400s a bad body before opening a stream", async () => {
    expect((await post({ message: "no session" })).status).toBe(400);
    expect((await post({ session_id: "bad session!", message: "x" })).status).toBe(400);
    expect((await post({ session_id: "s", message: "" })).status).toBe(400);
    expect((await post({ session_id: "s", message: "x", context: "dl_1" })).status).toBe(400);
    expect(bedrockSend).not.toHaveBeenCalled();
  });

  it("honours an authorization refusal", async () => {
    const { NextResponse } = await import("next/server");
    requirePipelineActor.mockResolvedValue({ error: NextResponse.json({ error: "no" }, { status: 401 }) });
    expect((await post({ session_id: "s", message: "x" })).status).toBe(401);
  });

  it("withholds the memory-writing tools from a non-admin session and refuses one the model calls anyway", async () => {
    // A configured knowledge memory, so a gate that leaked would show up as a real BatchDelete call
    // rather than being masked by the "not configured" no-op.
    process.env.KNOWLEDGE_MEMORY_ID = "deal_pipeline_test_knowledge-abc";
    requirePipelineActor.mockResolvedValue({ actor: "analyst@example.test", isAdmin: false });
    bedrockSend
      .mockResolvedValueOnce({ stream: toolRound("tu-3", "delete_memory", { record_id: "rec-1" }) })
      .mockResolvedValueOnce({ stream: textRound("An admin can remove that record from the Memory Manager.") });

    const { events } = await readFrames(
      await post({ session_id: "s", message: "delete memory record rec-1, yes confirmed" }),
    );

    // The model never sees the two write tools, and is told why in the system prompt.
    const first = bedrockSend.mock.calls[0][0];
    const offered = first.toolConfig.tools.map((t: { toolSpec: { name: string } }) => t.toolSpec.name);
    expect(offered).not.toContain("save_memory");
    expect(offered).not.toContain("delete_memory");
    expect(offered).toContain("propose_skill_update"); // proposals still need an admin's approval
    expect(first.system.map((s: { text: string }) => s.text).join("\n")).toContain("not in the pipeline admin group");

    // Calling one regardless is refused at the tool, not merely hidden in the catalog.
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "delete_memory",
      ok: false,
      summary: "requires the admin group",
    });
    expect(bedrockSend.mock.calls[1][0].messages[2].content[0].toolResult.status).toBe("error");
    expect(agentcoreSend.mock.calls.some((c) => c[0].__cmd === "BatchDelete")).toBe(false);
    expect(events[events.length - 1]).toEqual({ type: "done", session_id: "s" });
  });
});

describe("GET /api/pipeline/chat/history", () => {
  it("returns the caller's transcript for a session", async () => {
    agentcoreSend.mockResolvedValueOnce({
      events: [
        {
          eventTimestamp: new Date("2026-08-13T10:00:00Z"),
          payload: [{ conversational: { role: "USER", content: { text: "hi" } } }],
        },
      ],
    });
    const resp = await history.GET(new Request("http://x/api/pipeline/chat/history?session_id=sess-1"));
    const body = await resp.json();
    expect(body.session_id).toBe("sess-1");
    expect(body.messages).toEqual([{ role: "user", content: "hi", at: "2026-08-13T10:00:00.000Z" }]);
    expect(agentcoreSend.mock.calls[0][0]).toMatchObject({ sessionId: "sess-1", actorId: "user-example-test" });
  });

  it("requires a well-formed session_id", async () => {
    expect((await history.GET(new Request("http://x/api/pipeline/chat/history"))).status).toBe(400);
  });
});

describe("chatAgent helpers", () => {
  it("toConverseHistory merges same-role turns and drops a leading assistant turn", () => {
    const out = agent.toConverseHistory([
      { role: "assistant", content: "orphan", at: "1" },
      { role: "user", content: "a", at: "2" },
      { role: "user", content: "b", at: "3" },
      { role: "assistant", content: "c", at: "4" },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ text: "a\n\nb" }] },
      { role: "assistant", content: [{ text: "c" }] },
    ]);
  });

  it("contextNote names what the user is viewing, or nothing", () => {
    expect(agent.contextNote(undefined)).toBeNull();
    expect(agent.contextNote({ deal_id: "dl_1", email_id: "em_1" })).toContain("deal dl_1 and email em_1");
  });

  it("propose_skill_update refuses content that would not load as a skill", async () => {
    const out = await agent.executeTool(
      "propose_skill_update",
      { skill_name: "deal-parsing", proposed_content: "no frontmatter", summary: "s", rationale: "r" },
      { sessionId: "s", canWrite: true },
    );
    expect(out.ok).toBe(false);
    expect(out.summary).toMatch(/invalid SKILL.md/);
    expect(ddbSend.mock.calls.some((c) => c[0].__cmd === "PutItem")).toBe(false);
  });

  it("save_memory reports the unconfigured knowledge memory instead of pretending to save", async () => {
    const out = await agent.executeTool(
      "save_memory",
      { rule: "r", rationale: "why" },
      { sessionId: "s", canWrite: true },
    );
    expect(out).toMatchObject({ ok: false, summary: "knowledge memory is not configured" });
  });

  it("save_memory and delete_memory refuse a non-admin context before touching the memory", async () => {
    process.env.KNOWLEDGE_MEMORY_ID = "deal_pipeline_test_knowledge-abc";
    const ctx = { sessionId: "s", canWrite: false };
    const saved = await agent.executeTool("save_memory", { rule: "r", rationale: "why" }, ctx);
    expect(saved).toMatchObject({ ok: false, summary: "requires the admin group" });
    const deleted = await agent.executeTool("delete_memory", { record_id: "rec-1" }, ctx);
    expect(deleted).toMatchObject({ ok: false, summary: "requires the admin group" });
    expect(agentcoreSend).not.toHaveBeenCalled();

    // The same calls with the flag set reach the memory — the refusal is the flag, not the tool.
    const admin = await agent.executeTool("save_memory", { rule: "r", rationale: "why" }, { ...ctx, canWrite: true });
    expect(admin.ok).toBe(true);
    expect(agentcoreSend.mock.calls[0][0].__cmd).toBe("CreateEvent");
  });

  it("toolsFor withholds exactly the memory-writing tools from a non-admin", () => {
    const all = agent.TOOL_SPECS.map((t) => t.toolSpec?.name);
    expect(agent.toolsFor(true).map((t) => t.toolSpec?.name)).toEqual(all);
    expect(agent.toolsFor(false).map((t) => t.toolSpec?.name)).toEqual(
      all.filter((n) => n !== "save_memory" && n !== "delete_memory"),
    );
    expect(agent.roleNote(true)).toBeNull();
    expect(agent.roleNote(false)).toContain("Memory Manager");
  });

  it("an unknown tool is an error result, never a throw", async () => {
    const out = await agent.executeTool("nope", {}, { sessionId: "s", canWrite: true });
    expect(out.ok).toBe(false);
  });
});

// @vitest-environment node
/**
 * Tests for the `retry` action of `POST /api/recon/cases/[id]` — the analyst's recovery path for an
 * investigation that will never finish on its own.
 *
 * Two states qualify, and the difference is the point of these tests. IN_PROGRESS only LOOKS stuck,
 * so the retry re-drives the item and leaves the status alone. FAILED is a case the agent worker
 * proved died, so the retry must first move it back to IN_PROGRESS through the guarded status tool —
 * before the async invoke, because doing it afterwards races the worker's own write, and because a
 * second failure needs an IN_PROGRESS row to mark FAILED again.
 *
 * The node environment is deliberate, as in `reconCaseApprove.test.ts`: the route imports
 * `authorizeRequest`, which pulls in `jose`, and jsdom's cross-realm `Uint8Array` makes it throw
 * before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CASES_TABLE = "recon-dev-cases";
process.env.AGENT_WORKER_FUNCTION = "recon-dev-agent-worker";
process.env.AGENT_RUNTIME_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:1:runtime/r";

const ddbSend = vi.fn();
const lambdaSend = vi.fn();
const callGatewayTool = vi.fn();
const authorizeRequest = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  UpdateItemCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "Update", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })),
  InvokeCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Invoke", ...i })),
}));
vi.mock("@/lib/gatewayMcp", () => ({ callGatewayTool }));
vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));
vi.mock("@/lib/reconMemory", () => ({ recordLessonMemoryEvent: vi.fn() }));
vi.mock("@/lib/rescoreAgreement", () => ({ rescoreAgreement: vi.fn() }));
vi.mock("@/lib/emailDraftStore", () => ({
  DraftConflict: class DraftConflict extends Error {},
  editDraft: vi.fn(),
  approveDraft: vi.fn(),
  revokeDraftApproval: vi.fn(),
  discardDraft: vi.fn(),
  armSend: vi.fn(),
  markSent: vi.fn(),
}));

const { marshall } = await import("@aws-sdk/util-dynamodb");
const { POST } = await import("@/app/api/recon/cases/[id]/route");

const params = { params: Promise.resolve({ id: "i-1" }) };

const postRetry = () =>
  POST(
    new Request("http://x/api/recon/cases/i-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry" }),
    }),
    params,
  );

/** Seed the case row `getCase` reads, in the given status. */
function seedCase(status: string, over: Record<string, unknown> = {}) {
  ddbSend.mockResolvedValue({
    Item: marshall(
      {
        item_id: "i-1",
        status,
        domain: "loan_ops",
        item: { item_id: "i-1", domain: "loan_ops", attributes: {} },
        ...over,
      },
      { removeUndefinedValues: true },
    ),
  });
}

/** The `new_status` of every status-tool call, in order. */
function transitions(): string[] {
  return (callGatewayTool.mock.calls as Array<[string, { new_status: string }]>)
    .filter(([tool]) => tool === "recon-status___recon_update_status")
    .map(([, args]) => args.new_status);
}

/** The decoded payload of the single agent-worker invoke. */
function invokedPayload(): Record<string, unknown> {
  expect(lambdaSend).toHaveBeenCalledTimes(1);
  const cmd = lambdaSend.mock.calls[0][0] as { Payload: Uint8Array };
  return JSON.parse(new TextDecoder().decode(cmd.Payload));
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeRequest.mockResolvedValue({ ok: true, subject: "analyst@x.com" });
  callGatewayTool.mockResolvedValue({
    structuredContent: { transitioned: true },
  });
  lambdaSend.mockResolvedValue({ StatusCode: 202 });
});

describe("POST /api/recon/cases/[id] — retry", () => {
  it("re-drives a stuck IN_PROGRESS case without touching its status", async () => {
    seedCase("IN_PROGRESS");

    const res = await postRetry();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "IN_PROGRESS", retried: true });
    // Nothing to transition: the case is already where a re-investigation belongs.
    expect(transitions()).toEqual([]);
    expect(invokedPayload().item).toMatchObject({ item_id: "i-1" });
  });

  it("re-opens a FAILED case to IN_PROGRESS before invoking the worker", async () => {
    seedCase("FAILED", {
      failure_reason: "MaxTokensReachedException: output cap hit",
      failed_at: "2026-09-02T10:00:00",
    });

    const res = await postRetry();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "IN_PROGRESS", retried: true });
    // The transition is the whole difference from the IN_PROGRESS case above.
    expect(transitions()).toEqual(["IN_PROGRESS"]);
    // Ordering: the status write must land BEFORE the invoke, or it races the worker's own write.
    const statusCall = callGatewayTool.mock.invocationCallOrder[0];
    expect(statusCall).toBeLessThan(lambdaSend.mock.invocationCallOrder[0]);
  });

  it("does not invoke the worker when the FAILED case can no longer be re-opened", async () => {
    seedCase("FAILED");
    callGatewayTool.mockResolvedValue({
      structuredContent: { transitioned: false },
    });

    const res = await postRetry();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer be retried/);
    // Invoking anyway would start an investigation whose result has nowhere to land.
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("refuses to retry a case that reached a verdict", async () => {
    seedCase("PROPOSED");

    const res = await postRetry();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/IN_PROGRESS or FAILED/);
    expect(lambdaSend).not.toHaveBeenCalled();
    expect(transitions()).toEqual([]);
  });

  it("re-drives the item AS STORED, so a reprocess correction survives the retry", async () => {
    seedCase("FAILED", {
      item: {
        item_id: "i-1",
        domain: "loan_ops",
        attributes: { user_correction: "wrong facility", reprocess_count: 1 },
      },
    });

    await postRetry();

    expect(invokedPayload().item).toMatchObject({
      attributes: { user_correction: "wrong facility", reprocess_count: 1 },
    });
  });
});

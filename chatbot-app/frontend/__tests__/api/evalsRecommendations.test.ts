/**
 * Tests for /api/recon/evals/recommendations
 *
 * Two invariants are locked in here:
 *
 * 1. The client owns the wait, not the origin. The source batch evaluation takes ~65s live and
 *    CloudFront kills any origin request past 60s, so POST {type: SYSTEM_PROMPT} returns a
 *    batchEvaluationId and NEVER polls the batch; GET ?batchId= is a single side-effect-free
 *    probe that treats PENDING as still running and withholds the ARN until the batch is usable.
 * 2. Every member of both recommendationConfig unions is REQUIRED — including evaluationConfig.
 *    Spreading the configuration in conditionally makes the service reject the call with
 *    "Value at '...systemPrompt' failed to satisfy constraint: Member must not be null".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Read at module scope by the route (tool-description trace ARNs need a real account id).
process.env.AWS_ACCOUNT_ID = "123456789012";

const send = vi.fn();

vi.mock("@aws-sdk/client-bedrock-agentcore", () => ({
  BedrockAgentCoreClient: vi.fn().mockImplementation(() => ({ send })),
  StartRecommendationCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "StartRecommendation", ...i })),
  GetRecommendationCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "GetRecommendation", ...i })),
  StartBatchEvaluationCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "StartBatchEvaluation", ...i })),
  GetBatchEvaluationCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "GetBatchEvaluation", ...i })),
}));

vi.mock("@/lib/evalDataSource", () => ({
  evalDataSource: vi.fn().mockResolvedValue({
    backend: "runtime",
    serviceName: "recon-agent.DEFAULT",
    logGroupNames: ["aws/spans"],
  }),
}));

const currentSystemPrompt = vi.fn().mockResolvedValue({
  text: "You are the reconciliation analyst.",
  source: "runtime:s3:system-prompt.md",
});
vi.mock("@/lib/agentSystemPrompt", () => ({
  currentSystemPrompt: (backend: string) => currentSystemPrompt(backend),
}));

const listGatewayTools = vi
  .fn()
  .mockResolvedValue([
    { name: "general-ledger___gl_lookup", description: "Look up a GL entry" },
  ]);
vi.mock("@/lib/gatewayMcp", () => ({
  listGatewayTools: () => listGatewayTools(),
}));

const post = (body: unknown) =>
  new Request("http://x/api/recon/evals/recommendations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("recommendations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("POST for a system prompt starts the batch and returns without polling it", async () => {
    send.mockResolvedValueOnce({ batchEvaluationId: "optsrc_1-abc" });

    const { POST } =
      await import("@/app/api/recon/evals/recommendations/route");
    const res = await POST(post({ type: "SYSTEM_PROMPT_RECOMMENDATION" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      phase: "BATCH",
      batchEvaluationId: "optsrc_1-abc",
    });
    // Exactly one call: the start. Any GetBatchEvaluation here is the 504 regression returning.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].__cmd).toBe("StartBatchEvaluation");
  });

  it("POST with a batchEvaluationArn starts the recommendation from that source", async () => {
    send.mockResolvedValueOnce({ recommendationId: "rec-1" });

    const { POST } =
      await import("@/app/api/recon/evals/recommendations/route");
    const res = await POST(
      post({
        type: "SYSTEM_PROMPT_RECOMMENDATION",
        batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
      }),
    );
    const body = await res.json();

    expect(body.recommendationId).toBe("rec-1");
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0][0];
    expect(cmd.__cmd).toBe("StartRecommendation");
    const cfg = cmd.recommendationConfig.systemPromptRecommendationConfig;
    expect(cfg.agentTraces.batchEvaluation.batchEvaluationArn).toBe(
      "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
    );
    // All three members present — omitting either of these is a ValidationException.
    expect(cfg.systemPrompt).toEqual({
      text: "You are the reconciliation analyst.",
    });
    expect(cfg.evaluationConfig.evaluators).toEqual([
      {
        evaluatorArn:
          "arn:aws:bedrock-agentcore:::evaluator/Builtin.GoalSuccessRate",
      },
    ]);
    // Resolved for the ACTIVE backend, and reported back so the UI knows the baseline.
    expect(currentSystemPrompt).toHaveBeenCalledWith("runtime");
    expect(body.promptSource).toBe("runtime:s3:system-prompt.md");
  });

  it("POST prefers an explicit currentPrompt over the deployed one", async () => {
    send.mockResolvedValueOnce({ recommendationId: "rec-2" });

    const { POST } =
      await import("@/app/api/recon/evals/recommendations/route");
    const res = await POST(
      post({
        type: "SYSTEM_PROMPT_RECOMMENDATION",
        batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
        currentPrompt: "  A draft being iterated on.  ",
      }),
    );

    const cfg =
      send.mock.calls[0][0].recommendationConfig
        .systemPromptRecommendationConfig;
    expect(cfg.systemPrompt).toEqual({ text: "A draft being iterated on." });
    expect(currentSystemPrompt).not.toHaveBeenCalled();
    expect((await res.json()).promptSource).toBe("request");
  });

  it("POST fails loudly when the current prompt cannot be resolved", async () => {
    // Fail-loud rather than dropping the required member and letting the service answer with
    // "Member must not be null" — the user needs to know WHICH prompt is missing.
    currentSystemPrompt.mockRejectedValueOnce(
      new Error("The runtime backend's system prompt is empty"),
    );

    const { POST } =
      await import("@/app/api/recon/evals/recommendations/route");
    const res = await POST(
      post({
        type: "SYSTEM_PROMPT_RECOMMENDATION",
        batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
      }),
    );

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("system prompt is empty");
    expect(send).not.toHaveBeenCalled();
  });

  it("POST for tool descriptions sends the gateway's current descriptions", async () => {
    send.mockResolvedValueOnce({ recommendationId: "rec-3" });

    const { POST } =
      await import("@/app/api/recon/evals/recommendations/route");
    await POST(post({ type: "TOOL_DESCRIPTION_RECOMMENDATION" }));

    const cfg =
      send.mock.calls[0][0].recommendationConfig
        .toolDescriptionRecommendationConfig;
    expect(cfg.toolDescription.toolDescriptionText.tools).toEqual([
      {
        toolName: "general-ledger___gl_lookup",
        toolDescription: { text: "Look up a GL entry" },
      },
    ]);
    // No evaluationConfig on this union — the service rejects one here.
    expect(cfg.evaluationConfig).toBeUndefined();
    expect(cfg.agentTraces.cloudwatchLogs.serviceNames).toEqual([
      "recon-agent.DEFAULT",
    ]);
  });

  it("GET ?batchId treats PENDING as running and withholds the ARN", async () => {
    // batchEvaluationArn is populated from creation — the guard is the status, not its presence.
    send.mockResolvedValueOnce({
      status: "PENDING",
      batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
    });

    const { GET } = await import("@/app/api/recon/evals/recommendations/route");
    const res = await GET(
      new Request("http://x/api/recon/evals/recommendations?batchId=b1"),
    );
    const body = await res.json();

    expect(body).toEqual({
      status: "PENDING",
      running: true,
      batchEvaluationArn: null,
    });
  });

  it("GET ?batchId returns the ARN on COMPLETED_WITH_ERRORS (the normal outcome)", async () => {
    send.mockResolvedValueOnce({
      status: "COMPLETED_WITH_ERRORS",
      batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
    });

    const { GET } = await import("@/app/api/recon/evals/recommendations/route");
    const res = await GET(
      new Request("http://x/api/recon/evals/recommendations?batchId=b1"),
    );

    expect(await res.json()).toEqual({
      status: "COMPLETED_WITH_ERRORS",
      running: false,
      batchEvaluationArn: "arn:aws:bedrock-agentcore:::batch-evaluate/b1",
    });
  });

  it("GET ?batchId reports a FAILED batch as finished with no usable source", async () => {
    send.mockResolvedValueOnce({ status: "FAILED", batchEvaluationArn: "arn" });

    const { GET } = await import("@/app/api/recon/evals/recommendations/route");
    const res = await GET(
      new Request("http://x/api/recon/evals/recommendations?batchId=b1"),
    );
    const body = await res.json();

    expect(body.running).toBe(false);
    expect(body.batchEvaluationArn).toBeNull();
  });

  it("GET with neither id nor batchId is a 400", async () => {
    const { GET } = await import("@/app/api/recon/evals/recommendations/route");
    const res = await GET(
      new Request("http://x/api/recon/evals/recommendations"),
    );

    expect(res.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

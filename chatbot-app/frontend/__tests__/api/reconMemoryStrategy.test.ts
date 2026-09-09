// @vitest-environment node
/**
 * Tests for `GET /api/recon/memory/strategy` — the read-only view of the memory extraction strategy.
 *
 * What matters here: it is authenticated (the prompt is deployed configuration, and an
 * unauthenticated caller should not be able to enumerate the platform's config), an unconfigured
 * memory answers `configured: false` rather than erroring, and the response is the flattened
 * projection rather than the raw SDK union — the panel renders these fields directly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.RECON_MEMORY_ID = "recon_test_memory-abc123";

const controlSend = vi.fn();
// The gate itself is covered by api-auth's own tests; mocked here so these stay about the route's
// contract, with one case confirming a refusal is honoured before any AWS call is made.
const authorizeRequest = vi.fn();

vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));
vi.mock("@aws-sdk/client-bedrock-agentcore-control", () => ({
  BedrockAgentCoreControlClient: vi
    .fn()
    .mockImplementation(() => ({ send: controlSend })),
  GetMemoryCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "GetMemory", ...i })),
}));

const { GET } = await import("@/app/api/recon/memory/strategy/route");

/** The live strategy shape: CUSTOM + a semantic extraction override. */
const MEMORY = {
  status: "ACTIVE",
  strategies: [
    {
      strategyId: "str-abc",
      name: "lessons_learned",
      type: "CUSTOM",
      status: "ACTIVE",
      namespaces: ["reconciliation/lessons/{actorId}"],
      configuration: {
        type: "SEMANTIC_OVERRIDE",
        extraction: {
          customExtractionConfiguration: {
            semanticExtractionOverride: {
              appendToPrompt: "You are a long-term memory extraction agent…",
              modelId: "us.anthropic.claude-sonnet-5",
            },
          },
        },
      },
    },
  ],
};

function get() {
  return GET(new Request("http://x/api/recon/memory/strategy"));
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeRequest.mockResolvedValue({ ok: true, subject: "analyst" });
});

describe("GET /api/recon/memory/strategy", () => {
  it("returns the flattened strategy, including the live prompt", async () => {
    controlSend.mockResolvedValue({ memory: MEMORY });
    const body = await (await get()).json();

    expect(body.configured).toBe(true);
    expect(body.memoryStatus).toBe("ACTIVE");
    expect(body.strategies).toHaveLength(1);
    expect(body.strategies[0]).toMatchObject({
      name: "lessons_learned",
      type: "CUSTOM",
      configurationType: "SEMANTIC_OVERRIDE",
      status: "ACTIVE",
    });
    expect(body.strategies[0].extraction).toEqual({
      kind: "semanticExtractionOverride",
      modelId: "us.anthropic.claude-sonnet-5",
      appendToPrompt: "You are a long-term memory extraction agent…",
    });
  });

  it("asks GetMemory for the configured memory id", async () => {
    controlSend.mockResolvedValue({ memory: MEMORY });
    await get();
    expect(controlSend).toHaveBeenCalledWith(
      expect.objectContaining({
        __cmd: "GetMemory",
        memoryId: "recon_test_memory-abc123",
      }),
    );
  });

  it("refuses an unauthenticated caller without calling AWS", async () => {
    authorizeRequest.mockResolvedValue({
      ok: false,
      status: 401,
      message: "missing or malformed Authorization: Bearer <token> header",
    });
    const res = await get();
    expect(res.status).toBe(401);
    expect(controlSend).not.toHaveBeenCalled();
  });

  it("reports a GetMemory failure as a 500 with its message", async () => {
    controlSend.mockRejectedValue(
      new Error("AccessDeniedException: GetMemory"),
    );
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("AccessDeniedException");
  });

  it("tolerates a memory with no strategies", async () => {
    controlSend.mockResolvedValue({ memory: { status: "ACTIVE" } });
    const body = await (await get()).json();
    expect(body).toMatchObject({ configured: true, strategies: [] });
  });

  it("answers configured:false when RECON_MEMORY_ID is unset", async () => {
    // Re-imported with the variable cleared: the route reads it at module scope, matching the
    // feature-gate contract of the records route beside it.
    vi.resetModules();
    process.env.RECON_MEMORY_ID = "";
    const { GET: freshGet } =
      await import("@/app/api/recon/memory/strategy/route");
    const body = await (
      await freshGet(new Request("http://x/api/recon/memory/strategy"))
    ).json();

    expect(body).toEqual({
      configured: false,
      memoryStatus: null,
      strategies: [],
    });
    expect(controlSend).not.toHaveBeenCalled();
    process.env.RECON_MEMORY_ID = "recon_test_memory-abc123";
  });
});

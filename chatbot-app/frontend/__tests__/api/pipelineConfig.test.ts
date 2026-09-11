// @vitest-environment node
/**
 * `/api/pipeline/config`: the parsing agent's model id in SSM. GET must report only allowlisted
 * values (an unknown stored id would be refused by the parser, so showing it as live would lie) and
 * PUT must refuse anything off the list before it reaches the parameter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.AWS_REGION = "us-east-1";
process.env.PIPELINE_AGENT_MODEL_PARAM = "/deal-pipeline-test/agent-model-id";

const ssmSend = vi.fn();
const requireActor = vi.fn();
const requirePipelineAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/pipelineAdmin", () => ({ requirePipelineAdmin }));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  PutParameterCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));

const { GET, PUT } = await import("@/app/api/pipeline/config/route");
const { AGENT_MODEL_IDS } = await import("@/lib/pipeline/server/agentModels");

function get() {
  return GET(new Request("http://x/api/pipeline/config"));
}
function put(body: unknown) {
  return PUT(
    new Request("http://x/api/pipeline/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue({ actor: "reviewer" });
  requirePipelineAdmin.mockResolvedValue({ actor: "admin" });
});

describe("GET /api/pipeline/config", () => {
  it("reports null when the parameter does not exist yet", async () => {
    ssmSend.mockRejectedValue(Object.assign(new Error("nf"), { name: "ParameterNotFound" }));
    const body = await (await get()).json();
    expect(body).toEqual({ modelId: null, modelIds: AGENT_MODEL_IDS });
    expect(ssmSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Get",
      Name: "/deal-pipeline-test/agent-model-id",
    });
  });

  it("reports an allowlisted value", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "us.anthropic.claude-sonnet-5" } });
    expect((await (await get()).json()).modelId).toBe("us.anthropic.claude-sonnet-5");
  });

  it("reports an unrecognised stored value as null", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "some.other.model" } });
    expect((await (await get()).json()).modelId).toBeNull();
  });

  it("surfaces any other SSM failure as a 500", async () => {
    ssmSend.mockRejectedValue(new Error("AccessDenied"));
    expect((await get()).status).toBe(500);
  });
});

describe("PUT /api/pipeline/config", () => {
  it("writes an allowlisted model id with Overwrite", async () => {
    ssmSend.mockResolvedValue({});
    const resp = await put({ modelId: "us.anthropic.claude-opus-5" });
    expect(resp.status).toBe(200);
    expect(ssmSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Put",
      Name: "/deal-pipeline-test/agent-model-id",
      Value: "us.anthropic.claude-opus-5",
      Overwrite: true,
    });
  });

  it("refuses an id off the allowlist before touching SSM", async () => {
    const resp = await put({ modelId: "anthropic.claude-v2" });
    expect(resp.status).toBe(400);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("refuses a body without modelId", async () => {
    expect((await put({})).status).toBe(400);
  });

  it("honours the admin gate", async () => {
    const { NextResponse } = await import("next/server");
    requirePipelineAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });
    expect((await put({ modelId: "us.anthropic.claude-opus-5" })).status).toBe(403);
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

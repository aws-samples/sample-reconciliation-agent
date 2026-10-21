// @vitest-environment node
/**
 * `/api/pipeline/config`: the parsing agent's model id in SSM. GET must report only allowlisted
 * values (an unknown stored id would be refused by the parser, so showing it as live would lie) and
 * PUT must refuse anything off the list before it reaches the parameter.
 *
 * GET also carries the console's default model id (`lib/console/settings.ts`) so the Config tab can
 * offer "Use console default"; that value is reported raw and never written by this route.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { ssmModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeSsm, parameterNotFound } from "../helpers/fakeSsm";
import { admitted, refused } from "../helpers/gates";
import { jsonRequest } from "../helpers/http";

const env = scopedEnv(["CONSOLE_SETTINGS_PREFIX", "CONSOLE_DEFAULT_MODEL_ID"], {
  AWS_REGION: "us-east-1",
  PIPELINE_AGENT_MODEL_PARAM: "/deal-pipeline-test/agent-model-id",
});
afterAll(() => env.restore());

const ssmSend = vi.fn();
const requireActor = vi.fn();
const requireAppAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppAdmin }));
vi.mock("@aws-sdk/client-ssm", () => ssmModule(ssmSend));

const { GET, PUT } = await import("@/app/api/pipeline/config/route");
const { AGENT_MODEL_IDS } = await import("@/lib/server/agentModels");
const { invalidate } = await import("@/lib/console/settings");

const CONSOLE_PREFIX = "/deal-pipeline-test/console";

function get() {
  return GET(new Request("http://x/api/pipeline/config"));
}
function put(body: unknown) {
  return PUT(jsonRequest("PUT", "http://x/api/pipeline/config", body));
}

beforeEach(() => {
  vi.clearAllMocks();
  requireActor.mockResolvedValue(admitted("reviewer"));
  requireAppAdmin.mockResolvedValue(admitted("admin"));
  // The console layer is off unless a case turns it on; its cache must not carry between cases.
  env.set({ CONSOLE_SETTINGS_PREFIX: undefined, CONSOLE_DEFAULT_MODEL_ID: undefined });
  invalidate();
});

describe("GET /api/pipeline/config", () => {
  it("reports null when the parameter does not exist yet", async () => {
    ssmSend.mockRejectedValue(parameterNotFound());
    const body = await (await get()).json();
    expect(body).toEqual({ modelId: null, modelIds: AGENT_MODEL_IDS, consoleDefaultModelId: null });
    expect(ssmSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Get",
      Name: "/deal-pipeline-test/agent-model-id",
    });
    // Without the console layer, only the pipeline's own parameter is read.
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });

  it("reports the console default from its stored parameter when the layer is configured", async () => {
    env.set({ CONSOLE_SETTINGS_PREFIX: CONSOLE_PREFIX });
    const fake = createFakeSsm();
    fake.store.set("/deal-pipeline-test/agent-model-id", "us.anthropic.claude-sonnet-5");
    fake.seed(`${CONSOLE_PREFIX}/defaults`, { "model-id": "us.anthropic.claude-opus-5" });
    ssmSend.mockImplementation(fake.send);
    const body = await (await get()).json();
    // Reported raw beside the pipeline's own value; choosing it is still a PUT of the pipeline parameter.
    expect(body).toEqual({
      modelId: "us.anthropic.claude-sonnet-5",
      modelIds: AGENT_MODEL_IDS,
      consoleDefaultModelId: "us.anthropic.claude-opus-5",
    });
  });

  it("reports the console default from CONSOLE_DEFAULT_MODEL_ID when nothing is stored", async () => {
    env.set({ CONSOLE_DEFAULT_MODEL_ID: "some.other.model" });
    ssmSend.mockRejectedValue(parameterNotFound());
    const body = await (await get()).json();
    // Not filtered by the allowlist: the UI compares it against `modelIds` and can say when it is not offered.
    expect(body.consoleDefaultModelId).toBe("some.other.model");
    expect(body.modelId).toBeNull();
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
    requireAppAdmin.mockResolvedValue(refused(403, "not an admin"));
    expect((await put({ modelId: "us.anthropic.claude-opus-5" })).status).toBe(403);
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

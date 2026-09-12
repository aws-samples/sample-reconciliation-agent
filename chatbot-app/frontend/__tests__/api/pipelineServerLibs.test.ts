// @vitest-environment node
/**
 * The small server libraries the pipeline routes share: id generation, the environment reader
 * and the two Lambda invocation shapes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.AWS_REGION = "us-east-1";

const lambdaSend = vi.fn();
vi.mock("@aws-sdk/client-lambda", () => ({
  LambdaClient: vi.fn().mockImplementation(() => ({ send: lambdaSend })),
  InvokeCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Invoke", ...i })),
}));

const ids = await import("@/lib/pipeline/server/ids");
const { env } = await import("@/lib/pipeline/server/env");
const { invokeAsync, invokeSync } = await import("@/lib/pipeline/server/lambdaInvoke");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ids", () => {
  it("builds a readable, time-prefixed email id", () => {
    const at = new Date("2026-08-10T13:42:00Z");
    const id = ids.newEmailId("Northwind Automotive launches $500M add-on TLB", at);
    expect(id).toMatch(/^em_20260810T134200_northwind-automotive_[0-9a-z]{4}$/);
  });

  it("keeps two emails with the same subject in the same second distinct", () => {
    const at = new Date("2026-08-10T13:42:00Z");
    const a = ids.newEmailId("Same subject", at);
    const b = ids.newEmailId("Same subject", at);
    expect(a).not.toBe(b);
  });

  it("falls back to a neutral slug for a subject with no usable words", () => {
    expect(ids.newEmailId("!!", new Date("2026-01-01T00:00:00Z"))).toMatch(/_email_/);
  });

  it("generates prefixed ULIDs that sort by time", () => {
    const earlier = ids.newDealId(new Date("2026-08-10T00:00:00Z"));
    const later = ids.newDealId(new Date("2026-08-11T00:00:00Z"));
    expect(earlier).toMatch(/^dl_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(ids.newProposalId()).toMatch(/^sp_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(earlier < later).toBe(true);
  });
});

describe("env", () => {
  it("throws a message naming a missing required variable", () => {
    delete process.env.DEALS_TABLE;
    expect(() => env.dealsTable()).toThrow(/DEALS_TABLE/);
  });

  it("reads a required variable once it is set", () => {
    process.env.DEALS_TABLE = "deal-pipeline-dev-deals";
    expect(env.dealsTable()).toBe("deal-pipeline-dev-deals");
  });

  it("applies the design defaults for optional variables", () => {
    delete process.env.PIPELINE_SKILLS_PREFIX;
    delete process.env.PARSER_PROMPT_KEY;
    delete process.env.ASSISTANT_MODEL_ID;
    delete process.env.KNOWLEDGE_MEMORY_ID;
    expect(env.skillsPrefix()).toBe("skills/");
    expect(env.parserPromptKey()).toBe("prompts/parser-system.md");
    expect(env.assistantModelId()).toBe("us.anthropic.claude-sonnet-5");
    expect(env.knowledgeMemoryId()).toBe("");
  });

  it("treats a blank value as unset", () => {
    process.env.PIPELINE_SKILLS_PREFIX = "   ";
    expect(env.skillsPrefix()).toBe("skills/");
  });

  // The three names below collide with the recon BFF's when both apps share one container, and every
  // one of recon's values exists and is writable by the task role. So the bare name must NEVER be read:
  // a fallback would point the Skills and Config tabs at recon's bucket, skills and live Tier-2 model
  // parameter with no error, on exactly the deployment (recon-only, or a half-filled `.env.local`)
  // where the pipeline's own variables are missing.
  describe("PIPELINE_-prefixed names never fall back to the bare names the recon app owns", () => {
    beforeEach(() => {
      for (const name of [
        "PIPELINE_ASSETS_BUCKET",
        "ASSETS_BUCKET",
        "PIPELINE_AGENT_MODEL_PARAM",
        "AGENT_MODEL_PARAM",
        "PIPELINE_SKILLS_PREFIX",
        "SKILLS_PREFIX",
        "PIPELINE_SAMPLES_PREFIX",
      ]) {
        delete process.env[name];
      }
    });

    it("throws for the bucket when only recon's ASSETS_BUCKET is set", () => {
      process.env.ASSETS_BUCKET = "recon-dev-assets";
      expect(() => env.assetsBucket()).toThrow(/^PIPELINE_ASSETS_BUCKET is not set/);
    });

    it("reads the bucket from PIPELINE_ASSETS_BUCKET", () => {
      process.env.ASSETS_BUCKET = "recon-dev-assets";
      process.env.PIPELINE_ASSETS_BUCKET = "deal-pipeline-dev-assets";
      expect(env.assetsBucket()).toBe("deal-pipeline-dev-assets");
    });

    it("treats a blank prefixed bucket as unset and still refuses the bare name", () => {
      // `.env.example` ships `PIPELINE_ASSETS_BUCKET=` blank next to a filled `ASSETS_BUCKET=`.
      process.env.PIPELINE_ASSETS_BUCKET = "  ";
      process.env.ASSETS_BUCKET = "recon-dev-assets";
      expect(() => env.assetsBucket()).toThrow(/^PIPELINE_ASSETS_BUCKET is not set/);
    });

    it("throws for the model parameter when only recon's AGENT_MODEL_PARAM is set", () => {
      // Required, not defaulted: `PUT /config` writes this parameter, and recon's Tier-2 model lives
      // under the bare name.
      expect(() => env.agentModelParam()).toThrow(/^PIPELINE_AGENT_MODEL_PARAM is not set/);
      process.env.AGENT_MODEL_PARAM = "/recon-dev/agent-model-id";
      expect(() => env.agentModelParam()).toThrow(/^PIPELINE_AGENT_MODEL_PARAM is not set/);
    });

    it("reads the model parameter from PIPELINE_AGENT_MODEL_PARAM", () => {
      process.env.AGENT_MODEL_PARAM = "/recon-dev/agent-model-id";
      process.env.PIPELINE_AGENT_MODEL_PARAM = "/deal-pipeline-dev/agent-model-id";
      expect(env.agentModelParam()).toBe("/deal-pipeline-dev/agent-model-id");
    });

    it("ignores recon's SKILLS_PREFIX and defaults the skills prefix", () => {
      process.env.SKILLS_PREFIX = "recon-skills/";
      expect(env.skillsPrefix()).toBe("skills/");
      process.env.PIPELINE_SKILLS_PREFIX = "pipeline/skills/";
      expect(env.skillsPrefix()).toBe("pipeline/skills/");
    });

    it("reads the samples prefix from its own name only, defaulting to samples/", () => {
      expect(env.samplesPrefix()).toBe("samples/");
      process.env.PIPELINE_SAMPLES_PREFIX = "corpus/";
      expect(env.samplesPrefix()).toBe("corpus/");
    });

    it("names exactly one variable in a required-variable message", () => {
      delete process.env.EMAILS_TABLE;
      expect(() => env.emailsTable()).toThrow(/^EMAILS_TABLE is not set/);
    });
  });
});

describe("lambdaInvoke", () => {
  it("invokeAsync fires an Event invocation with the JSON payload", async () => {
    lambdaSend.mockResolvedValue({ StatusCode: 202 });
    await invokeAsync("deal-pipeline-dev-parser", { email_id: "em_1" });
    const cmd = lambdaSend.mock.calls[0][0];
    expect(cmd).toMatchObject({
      __cmd: "Invoke",
      FunctionName: "deal-pipeline-dev-parser",
      InvocationType: "Event",
    });
    expect(JSON.parse(Buffer.from(cmd.Payload).toString())).toEqual({ email_id: "em_1" });
  });

  it("invokeSync returns the parsed result", async () => {
    lambdaSend.mockResolvedValue({
      Payload: new TextEncoder().encode(JSON.stringify({ accepted: true, errors: [] })),
    });
    const out = await invokeSync<{ accepted: boolean }>("oms", { deal_id: "dl_1" });
    expect(out.accepted).toBe(true);
    expect(lambdaSend.mock.calls[0][0].InvocationType).toBe("RequestResponse");
  });

  it("invokeSync turns a FunctionError into a thrown error naming the function", async () => {
    // Lambda reports an unhandled exception as a 200 with FunctionError set; treating that payload
    // as a result would make a crashed validator look like a verdict.
    lambdaSend.mockResolvedValue({
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: "boom" })),
    });
    await expect(invokeSync("oms", {})).rejects.toThrow(/oms failed \(Unhandled\).*boom/);
  });

  it("invokeSync rejects a non-JSON payload", async () => {
    lambdaSend.mockResolvedValue({ Payload: new TextEncoder().encode("<html>") });
    await expect(invokeSync("oms", {})).rejects.toThrow(/non-JSON/);
  });
});

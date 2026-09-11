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

  it("makes ids safe for AgentCore actor/session fields", () => {
    expect(ids.memorySafeId("user@example.test|abc def")).toBe("user-example-test-abc-def");
    expect(ids.memorySafeId("")).toBe("unknown");
    expect(ids.memorySafeId("x".repeat(150))).toHaveLength(100);
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
    delete process.env.SKILLS_PREFIX;
    delete process.env.PARSER_PROMPT_KEY;
    delete process.env.ASSISTANT_MODEL_ID;
    delete process.env.KNOWLEDGE_MEMORY_ID;
    expect(env.skillsPrefix()).toBe("skills/");
    expect(env.parserPromptKey()).toBe("prompts/parser-system.md");
    expect(env.assistantModelId()).toBe("us.anthropic.claude-sonnet-5");
    expect(env.knowledgeMemoryId()).toBe("");
  });

  it("treats a blank value as unset", () => {
    process.env.SKILLS_PREFIX = "   ";
    expect(env.skillsPrefix()).toBe("skills/");
  });

  // The three names below collide with the recon BFF's when both apps share one container. The
  // prefixed name must win whenever it is set, or the pipeline silently reads recon's bucket, model
  // parameter and skills — all of which exist, so nothing would fail.
  describe("PIPELINE_-prefixed names shadow the bare names the recon app owns", () => {
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

    it("prefers the prefixed bucket and falls back to the bare one", () => {
      process.env.ASSETS_BUCKET = "recon-dev-assets";
      expect(env.assetsBucket()).toBe("recon-dev-assets");
      process.env.PIPELINE_ASSETS_BUCKET = "deal-pipeline-dev-assets";
      expect(env.assetsBucket()).toBe("deal-pipeline-dev-assets");
    });

    it("names both bucket variables when neither is set", () => {
      expect(() => env.assetsBucket()).toThrow(/PIPELINE_ASSETS_BUCKET \(or ASSETS_BUCKET\)/);
    });

    it("treats a blank prefixed value as unset and keeps reading the bare name", () => {
      process.env.PIPELINE_ASSETS_BUCKET = "  ";
      process.env.ASSETS_BUCKET = "deal-pipeline-dev-assets";
      expect(env.assetsBucket()).toBe("deal-pipeline-dev-assets");
    });

    it("prefers the prefixed model parameter, then the bare one, then the design default", () => {
      expect(env.agentModelParam()).toBe("/deal-pipeline-dev/agent-model-id");
      process.env.AGENT_MODEL_PARAM = "/recon-dev/agent-model-id";
      expect(env.agentModelParam()).toBe("/recon-dev/agent-model-id");
      process.env.PIPELINE_AGENT_MODEL_PARAM = "/deal-pipeline-dev/agent-model-id";
      expect(env.agentModelParam()).toBe("/deal-pipeline-dev/agent-model-id");
    });

    it("prefers the prefixed skills prefix, then the bare one, then the design default", () => {
      expect(env.skillsPrefix()).toBe("skills/");
      process.env.SKILLS_PREFIX = "recon-skills/";
      expect(env.skillsPrefix()).toBe("recon-skills/");
      process.env.PIPELINE_SKILLS_PREFIX = "pipeline/skills/";
      expect(env.skillsPrefix()).toBe("pipeline/skills/");
    });

    it("reads the samples prefix from its own name only, defaulting to samples/", () => {
      expect(env.samplesPrefix()).toBe("samples/");
      process.env.PIPELINE_SAMPLES_PREFIX = "corpus/";
      expect(env.samplesPrefix()).toBe("corpus/");
    });

    it("keeps a single-name required variable's message to that one name", () => {
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

/**
 * Tests for currentSystemPrompt (the optimizer's baseline resolver).
 *
 * Two properties matter here. It must resolve the SAME shared object for both backends — feeding
 * the optimizer a per-backend copy is how the stale "classify against the Skills catalog" text
 * survived a correction that had already landed in the repo. And it must never hand the optimizer
 * the harness's calling contract: the recommendation is written back to the shared object, so a
 * paraphrased submit_proposal field list would leak into the runtime prompt and break the harness.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ASSETS_BUCKET = "recon-dev-assets";

const s3Send = vi.fn();
const ssmSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "GetParameter", ...i })),
}));

const core = (text: string) => ({
  Body: { transformToString: async () => text },
});

describe("currentSystemPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmSend.mockResolvedValue({ Parameter: { Value: "none" } });
  });

  it("resolves the same shared object for both backends", async () => {
    const { currentSystemPrompt } = await import("@/lib/agentSystemPrompt");

    s3Send.mockResolvedValue(core("shared policy"));
    const rt = await currentSystemPrompt("runtime");
    const hn = await currentSystemPrompt("harness");

    expect(rt.text).toBe("shared policy");
    expect(hn.text).toBe("shared policy");
    expect(rt.source).toBe("shared:s3:system-prompt.md");
    expect(hn.source).toBe(rt.source);
    // Only the core key is ever read — never the harness contract object.
    for (const [cmd] of s3Send.mock.calls) {
      expect(cmd.Key).toBe("system-prompt.md");
    }
  });

  it("names the deployed version in the provenance without changing the text", async () => {
    s3Send.mockResolvedValue(core("shared policy"));
    ssmSend.mockResolvedValue({ Parameter: { Value: "v0002" } });

    const { currentSystemPrompt } = await import("@/lib/agentSystemPrompt");
    const got = await currentSystemPrompt("harness");

    expect(got.text).toBe("shared policy");
    expect(got.source).toBe("shared:s3:system-prompt.md (deployed v0002)");
  });

  it("still resolves when the config pointer is unreadable", async () => {
    // The pointer is informational now; an unset parameter must not fail the optimization.
    s3Send.mockResolvedValue(core("shared policy"));
    ssmSend.mockRejectedValue(new Error("ParameterNotFound"));

    const { currentSystemPrompt } = await import("@/lib/agentSystemPrompt");
    const got = await currentSystemPrompt("runtime");

    expect(got.text).toBe("shared policy");
    expect(got.source).toBe("shared:s3:system-prompt.md");
  });

  it("fails loudly on an empty prompt object", async () => {
    s3Send.mockResolvedValue(core("   \n"));

    const { currentSystemPrompt } = await import("@/lib/agentSystemPrompt");
    await expect(currentSystemPrompt("runtime")).rejects.toThrow(
      /system prompt is empty/,
    );
  });

  it("rejects an unknown backend", async () => {
    const { currentSystemPrompt } = await import("@/lib/agentSystemPrompt");
    await expect(currentSystemPrompt("legacy")).rejects.toThrow(
      /Unknown agent backend/,
    );
    expect(s3Send).not.toHaveBeenCalled();
  });
});

/**
 * Tests for /api/recon/harness/configs/deploy
 *
 * Deploy is two ordered writes: the version's prompt goes into the shared prompt object BOTH
 * Tier-2 backends read, and only then does the SSM pointer move. The pointer alone is read only
 * by the harness worker, so moving it without the prompt write is a no-op under the default
 * runtime backend — the version would report LIVE while the runtime kept serving the old prompt.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ASSETS_BUCKET = "recon-dev-assets";
process.env.HARNESS_CONFIG_VERSION_PARAM = "/recon-dev/harness-config-version";

const s3Send = vi.fn();
const ssmSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  PutObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  PutParameterCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "PutParameter", ...i })),
}));

const post = (body: unknown) =>
  new Request("http://x/api/recon/harness/configs/deploy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const configDoc = (system_prompt: string) => ({
  Body: { transformToString: async () => JSON.stringify({ system_prompt }) },
});

describe("config-version deploy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmSend.mockResolvedValue({});
  });

  it("writes the version's prompt to the shared object, then moves the pointer", async () => {
    s3Send
      .mockResolvedValueOnce(configDoc("OPTIMIZED PROMPT"))
      .mockResolvedValueOnce({});

    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    const res = await POST(post({ version: "v0003" }));
    const body = await res.json();

    expect(body).toEqual({ deployed: "v0003", promptKey: "system-prompt.md" });
    // Read the version document…
    expect(s3Send.mock.calls[0][0]).toMatchObject({
      __cmd: "Get",
      Key: "harness-configs/v0003.json",
    });
    // …then write the SHARED prompt object both backends read.
    expect(s3Send.mock.calls[1][0]).toMatchObject({
      __cmd: "Put",
      Bucket: "recon-dev-assets",
      Key: "system-prompt.md",
      Body: "OPTIMIZED PROMPT",
    });
    expect(ssmSend.mock.calls[0][0]).toMatchObject({
      __cmd: "PutParameter",
      Name: "/recon-dev/harness-config-version",
      Value: "v0003",
    });
  });

  it("writes the prompt BEFORE the pointer", async () => {
    // Order is the safety property: a pointer moved first would advertise a version whose text is
    // not in effect — the exact failure mode being fixed.
    const order: string[] = [];
    s3Send.mockImplementation(async (cmd) => {
      order.push(cmd.__cmd === "Put" ? "prompt" : "read");
      return cmd.__cmd === "Put" ? {} : configDoc("P");
    });
    ssmSend.mockImplementation(async () => {
      order.push("pointer");
      return {};
    });

    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    await POST(post({ version: "v0004" }));

    expect(order).toEqual(["read", "prompt", "pointer"]);
  });

  it("refuses a version with no prompt instead of moving the pointer alone", async () => {
    s3Send.mockResolvedValueOnce(configDoc("   "));

    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    const res = await POST(post({ version: "v0005" }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("no system_prompt");
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("refuses an optimizer-derived version whose approval rule was not acknowledged", async () => {
    // Every system-prompt recommendation comes back with this injected rule; deploying it would
    // tell BOTH backends to wait for an approval this platform never asks for.
    s3Send.mockResolvedValueOnce(
      configDoc(
        "State the planned action and wait for explicit approval. Do not treat silence as consent.",
      ),
    );

    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    const res = await POST(post({ version: "v0006" }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.policyWarnings).toHaveLength(2);
    // Nothing written: not the prompt object, not the pointer.
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("deploys the same version once the warnings are acknowledged", async () => {
    s3Send
      .mockResolvedValueOnce(
        configDoc("… wait for explicit approval before acting."),
      )
      .mockResolvedValueOnce({});

    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    const res = await POST(
      post({ version: "v0006", acknowledgeWarnings: true }),
    );

    expect(res.status).toBe(200);
    expect(s3Send.mock.calls[1][0]).toMatchObject({
      __cmd: "Put",
      Key: "system-prompt.md",
    });
    expect(ssmSend).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed version without touching anything", async () => {
    const { POST } =
      await import("@/app/api/recon/harness/configs/deploy/route");
    const res = await POST(post({ version: "latest" }));

    expect(res.status).toBe(400);
    expect(s3Send).not.toHaveBeenCalled();
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

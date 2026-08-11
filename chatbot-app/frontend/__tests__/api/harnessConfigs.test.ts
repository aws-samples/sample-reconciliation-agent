/**
 * Tests for /api/recon/harness/configs (list + archive).
 *
 * Two behaviors are locked in here:
 *
 * 1. DRIFT. A version document's `system_prompt` is a snapshot taken at save time. The Skills tab
 *    (PUT /api/recon/system-prompt) writes the shared prompt object both Tier-2 backends read and
 *    does NOT move the version pointer — so after such an edit the pointer names a version whose
 *    text is no longer live. GET must report that as liveMatchesDeployed: false instead of letting
 *    the UI show a plain green LIVE badge.
 * 2. ARCHIVE, not delete. Versions are the record of what ran and the deployed one is the rollback
 *    target, so archiving is a soft flag and the deployed version cannot be archived at all.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.ASSETS_BUCKET = "recon-dev-assets";
process.env.HARNESS_CONFIG_VERSION_PARAM = "/recon-dev/harness-config-version";

const s3Send = vi.fn();
const ssmSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  ListObjectsV2Command: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "List", ...i })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  PutObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "GetParameter", ...i })),
}));

type Doc = Record<string, unknown>;
const body = (value: unknown) => ({
  Body: {
    transformToString: async () =>
      typeof value === "string" ? value : JSON.stringify(value),
  },
});

/**
 * Route the mocked S3 client by command: List returns the given keys, Get returns either a version
 * document or the shared prompt object, Put succeeds.
 */
function mockS3({
  docs,
  livePrompt,
}: {
  docs: Doc[];
  livePrompt?: string | Error;
}) {
  s3Send.mockImplementation(async (cmd) => {
    if (cmd.__cmd === "List") {
      return {
        Contents: docs.map((d) => ({
          Key: `harness-configs/${d.version}.json`,
        })),
      };
    }
    if (cmd.__cmd === "Get") {
      if (cmd.Key === "system-prompt.md") {
        if (livePrompt instanceof Error) throw livePrompt;
        if (livePrompt === undefined) throw new Error("NoSuchKey");
        return body(livePrompt);
      }
      const found = docs.find(
        (d) => `harness-configs/${d.version}.json` === cmd.Key,
      );
      if (!found) throw new Error(`NoSuchKey ${cmd.Key}`);
      return body(found);
    }
    return {};
  });
}

const V1 = { version: "v0001", system_prompt: "OLD PROMPT", comment: "test" };
const V2 = {
  version: "v0002",
  system_prompt: "DEPLOYED PROMPT",
  comment: "from recommendation",
};

const get = (qs = "") =>
  new Request(`http://x/api/recon/harness/configs${qs}`) as never;
const patch = (b: unknown) =>
  new Request("http://x/api/recon/harness/configs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b),
  });

describe("config versions — list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmSend.mockResolvedValue({ Parameter: { Value: "v0002" } });
  });

  it("reports no drift when the live prompt is still the deployed version's text", async () => {
    mockS3({ docs: [V1, V2], livePrompt: "DEPLOYED PROMPT\n" }); // trailing newline tolerated

    const { GET } = await import("@/app/api/recon/harness/configs/route");
    const res = await GET(get());
    const json = await res.json();

    expect(json.deployed).toBe("v0002");
    expect(json.liveMatchesDeployed).toBe(true);
    expect(json.livePromptChars).toBe(16);
  });

  it("reports drift when the shared prompt object was edited after the deploy", async () => {
    // Exactly what a Skills-tab save does: the object changes, the pointer does not.
    mockS3({ docs: [V1, V2], livePrompt: "EDITED IN THE SKILLS TAB" });

    const { GET } = await import("@/app/api/recon/harness/configs/route");
    const json = await (await GET(get())).json();

    expect(json.deployed).toBe("v0002");
    expect(json.liveMatchesDeployed).toBe(false);
  });

  it("leaves drift unknown — not true — when the prompt object cannot be read", async () => {
    mockS3({ docs: [V1, V2], livePrompt: new Error("AccessDenied") });

    const { GET } = await import("@/app/api/recon/harness/configs/route");
    const json = await (await GET(get())).json();

    expect(json.liveMatchesDeployed).toBeNull();
    expect(json.configs).toHaveLength(2);
  });

  it("hides archived versions by default and returns them on request", async () => {
    const archived = {
      ...V1,
      archived: true,
      archived_at: "2026-08-03T00:00:00Z",
    };
    mockS3({ docs: [archived, V2], livePrompt: "DEPLOYED PROMPT" });

    const { GET } = await import("@/app/api/recon/harness/configs/route");
    const hidden = await (await GET(get())).json();
    expect(hidden.configs.map((c: Doc) => c.version)).toEqual(["v0002"]);
    expect(hidden.archivedCount).toBe(1);

    const shown = await (await GET(get("?includeArchived=1"))).json();
    expect(shown.configs.map((c: Doc) => c.version)).toEqual([
      "v0002",
      "v0001",
    ]);
  });
});

describe("config versions — archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ssmSend.mockResolvedValue({ Parameter: { Value: "v0002" } });
  });

  it("archives a non-deployed version by flagging the document, not deleting it", async () => {
    mockS3({ docs: [V1, V2] });

    const { PATCH } = await import("@/app/api/recon/harness/configs/route");
    const res = await PATCH(patch({ version: "v0001", archived: true }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.archived).toBe(true);
    expect(json.archived_at).toBeTruthy();
    // The prompt snapshot survives — archive is visibility metadata, not a content change.
    expect(json.system_prompt).toBe("OLD PROMPT");
    const put = s3Send.mock.calls.find((c) => c[0].__cmd === "Put")?.[0];
    expect(put).toMatchObject({ Key: "harness-configs/v0001.json" });
  });

  it("refuses to archive the deployed version", async () => {
    mockS3({ docs: [V1, V2] });

    const { PATCH } = await import("@/app/api/recon/harness/configs/route");
    const res = await PATCH(patch({ version: "v0002", archived: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("is deployed");
    expect(s3Send.mock.calls.some((c) => c[0].__cmd === "Put")).toBe(false);
  });

  it("unarchives by clearing the flag", async () => {
    mockS3({
      docs: [{ ...V1, archived: true, archived_at: "2026-08-03" }, V2],
    });

    const { PATCH } = await import("@/app/api/recon/harness/configs/route");
    const json = await (
      await PATCH(patch({ version: "v0001", archived: false }))
    ).json();

    expect(json.archived).toBe(false);
    expect(json.archived_at).toBeNull();
  });

  it("rejects a malformed request without writing", async () => {
    mockS3({ docs: [V1, V2] });

    const { PATCH } = await import("@/app/api/recon/harness/configs/route");
    expect(
      (await PATCH(patch({ version: "latest", archived: true }))).status,
    ).toBe(400);
    expect((await PATCH(patch({ version: "v0001" }))).status).toBe(400);
    expect(s3Send.mock.calls.some((c) => c[0].__cmd === "Put")).toBe(false);
  });
});

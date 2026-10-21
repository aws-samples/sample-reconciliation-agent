// @vitest-environment node
/**
 * `GET /api/pipeline/samples` and the corpus reader behind it, from both of its sources.
 *
 * The directory cases run against the REAL files under `data/deal-emails`: the simulate dialog is
 * the demo's only trigger, so a corpus file that has drifted from the shape the reader expects must
 * fail here rather than as an empty menu on stage. The S3 cases run against a mocked bucket and
 * hold the container path to the same ids and the same shape — if the two sources ever disagreed,
 * a sample picked from the dialog in the console would 404 on the very next request.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { s3Module } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeS3 } from "../helpers/fakeS3";
import { admitted, refused } from "../helpers/gates";

const env = scopedEnv(["SAMPLE_EMAILS_DIR", "PIPELINE_SAMPLES_PREFIX", "PIPELINE_ASSETS_BUCKET"], {
  AWS_REGION: "us-east-1",
});
afterAll(() => env.restore());

const s3Send = vi.fn();
const requireActor = vi.fn();
vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@aws-sdk/client-s3", () => s3Module(s3Send));

const { GET } = await import("@/app/api/pipeline/samples/route");
const { getSample, listSamples, resolveSamplesSource, samplesDir } = await import(
  "@/lib/pipeline/server/samples"
);

const CORPUS_DIR = join(process.cwd(), "../../data/deal-emails");
const CORPUS_IDS = readdirSync(CORPUS_DIR)
  .filter((n) => n.endsWith(".json"))
  .map((n) => n.replace(/\.json$/, ""))
  .sort();

/** A path that does not exist, which is what the container's cwd looks like to the reader. */
const NO_SUCH_DIR = "./__no_such_samples_dir__";

/**
 * In-memory bucket behind the S3 mock, keyed by object key. `pages` splits the listing into that
 * many ListObjectsV2 pages so pagination is exercised with a corpus far smaller than 1000 keys.
 */
function installBucket(objects: Record<string, string>, pages = 1) {
  s3Send.mockImplementation(createFakeS3(objects, { pages }).send);
}

function sample(id: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    source_kind: "bank-notice",
    from: "Arranger Desk <syndicate@arranger.example>",
    to: "New Issues Desk <new-issues@example-firm.test>",
    sent: "2026-08-12T14:05:00-04:00",
    subject: `Deal ${id}`,
    body: `Body of ${id}`,
    ...extra,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  env.set({
    SAMPLE_EMAILS_DIR: undefined,
    PIPELINE_SAMPLES_PREFIX: undefined,
    PIPELINE_ASSETS_BUCKET: "test-pipeline-assets",
  });
  requireActor.mockResolvedValue(admitted("reviewer"));
});

describe("samples reader — repository directory", () => {
  it("resolves the default directory to the repository corpus", () => {
    expect(samplesDir()).toBe(CORPUS_DIR);
  });

  it("reads from the directory whenever it exists, even with no SAMPLE_EMAILS_DIR set", async () => {
    expect(await resolveSamplesSource()).toEqual({ kind: "directory", dir: CORPUS_DIR });
  });

  it("lists every corpus file in name order with the fields the dialog shows", async () => {
    const samples = await listSamples();
    expect(samples.map((s) => s.id)).toEqual(CORPUS_IDS);
    expect(samples.length).toBeGreaterThanOrEqual(7);
    for (const s of samples) {
      expect(s.subject).toBeTruthy();
      expect(s.from).toBeTruthy();
      expect(Number.isNaN(Date.parse(s.sent)), `${s.id} has a bad sent date`).toBe(false);
      expect(["news-alert", "bank-notice", "manual"]).toContain(s.source_kind);
    }
    // The directory answered; the bucket was never consulted.
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("reads one corpus email in full", async () => {
    const id = CORPUS_IDS.find((i) => i.includes("copperfield"))!;
    const sample = await getSample(id);
    expect(sample?.id).toBe(id);
    expect(sample?.source_kind).toBe("bank-notice");
    expect(sample?.body).toContain("Copperfield");
    expect(sample?.to).toBeTruthy();
  });

  it("refuses ids that could escape the corpus directory", async () => {
    // The id becomes a file name; the character check is what keeps this from reading arbitrary files.
    expect(await getSample("../package")).toBeNull();
    expect(await getSample("/etc/hosts")).toBeNull();
    expect(await getSample("")).toBeNull();
  });

  it("returns null for an unknown id rather than throwing", async () => {
    expect(await getSample("99-no-such-sample")).toBeNull();
  });
});

describe("samples reader — S3 when the directory is absent", () => {
  beforeEach(() => {
    env.set({ SAMPLE_EMAILS_DIR: NO_SUCH_DIR });
  });

  it("falls back to the bucket under the default prefix", async () => {
    expect(await resolveSamplesSource()).toEqual({ kind: "s3", prefix: "samples/" });
  });

  it("honours PIPELINE_SAMPLES_PREFIX", async () => {
    env.set({ PIPELINE_SAMPLES_PREFIX: "pipeline/samples/" });
    expect(await resolveSamplesSource()).toEqual({ kind: "s3", prefix: "pipeline/samples/" });
  });

  it("lists the .json objects directly under the prefix, in key order, as the same SampleEmail shape", async () => {
    installBucket({
      "samples/02-bank-notice-b.json": sample("02-bank-notice-b"),
      "samples/01-news-alert-a.json": sample("01-news-alert-a", { source_kind: "news-alert" }),
      // Neither of these is a sample: one is nested, one is not JSON.
      "samples/archive/00-old.json": sample("00-old"),
      "samples/README.md": "# not a sample",
      // Recon's skills share the bucket in the composed deployment; the prefix keeps them out.
      "skills/deal-parsing/SKILL.md": "---\nname: deal-parsing\n---",
    });
    const samples = await listSamples();
    expect(samples).toEqual([
      {
        id: "01-news-alert-a",
        subject: "Deal 01-news-alert-a",
        source_kind: "news-alert",
        sent: "2026-08-12T14:05:00-04:00",
        from: "Arranger Desk <syndicate@arranger.example>",
      },
      {
        id: "02-bank-notice-b",
        subject: "Deal 02-bank-notice-b",
        source_kind: "bank-notice",
        sent: "2026-08-12T14:05:00-04:00",
        from: "Arranger Desk <syndicate@arranger.example>",
      },
    ]);
    const list = s3Send.mock.calls.find((c) => c[0].__cmd === "List")![0];
    expect(list).toMatchObject({ Bucket: "test-pipeline-assets", Prefix: "samples/" });
  });

  it("walks every listing page", async () => {
    installBucket(
      Object.fromEntries(
        ["01-a", "02-b", "03-c", "04-d", "05-e"].map((id) => [`samples/${id}.json`, sample(id)]),
      ),
      3,
    );
    const ids = (await listSamples()).map((s) => s.id);
    expect(ids).toEqual(["01-a", "02-b", "03-c", "04-d", "05-e"]);
    expect(s3Send.mock.calls.filter((c) => c[0].__cmd === "List")).toHaveLength(3);
  });

  it("uses the object name as the id, so a listed id always reads back", async () => {
    // A file whose own `id` disagrees with its name would otherwise list under one id and 404 under
    // it on the next request: the dialog POSTs what it listed, and the reader looks up `<id>.json`.
    installBucket({ "samples/07-renamed.json": sample("something-else") });
    const [listed] = await listSamples();
    expect(listed.id).toBe("07-renamed");
    expect((await getSample("07-renamed"))?.id).toBe("07-renamed");
  });

  it("reads one email in full from the bucket", async () => {
    installBucket({ "samples/06-copperfield.json": sample("06-copperfield", { cc: "desk@example-firm.test" }) });
    const got = await getSample("06-copperfield");
    expect(got).toMatchObject({
      id: "06-copperfield",
      source_kind: "bank-notice",
      cc: "desk@example-firm.test",
      body: "Body of 06-copperfield",
    });
    expect(s3Send.mock.calls[0][0]).toMatchObject({
      __cmd: "GetObject",
      Bucket: "test-pipeline-assets",
      Key: "samples/06-copperfield.json",
    });
  });

  it("returns null for an unknown id and coerces an unexpected source_kind to manual", async () => {
    installBucket({ "samples/08-odd.json": sample("08-odd", { source_kind: "carrier-pigeon" }) });
    expect(await getSample("99-no-such-sample")).toBeNull();
    expect((await getSample("08-odd"))?.source_kind).toBe("manual");
  });

  it("refuses ids that could escape the prefix without touching the bucket", async () => {
    installBucket({});
    expect(await getSample("../skills/deal-parsing/SKILL")).toBeNull();
    expect(await getSample("Upper")).toBeNull();
    expect(s3Send).not.toHaveBeenCalled();
  });

  it("names PIPELINE_ASSETS_BUCKET when it is unset, even with recon's ASSETS_BUCKET present", async () => {
    env.set({ PIPELINE_ASSETS_BUCKET: undefined });
    env.set({ ASSETS_BUCKET: "recon-dev-assets" });
    await expect(listSamples()).rejects.toThrow(/^PIPELINE_ASSETS_BUCKET is not set/);
  });

  it("propagates a read failure instead of reporting an empty corpus", async () => {
    // "Searched, found nothing" and "the read failed" are different answers: an access-denied bucket
    // must not render as an empty menu that looks like a corpus with no samples.
    s3Send.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(listSamples()).rejects.toThrow(/denied/);
  });
});

describe("GET /api/pipeline/samples", () => {
  it("returns the corpus list from the directory", async () => {
    const resp = await GET(new Request("http://x/api/pipeline/samples"));
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { id: string }[];
    expect(body.map((s) => s.id)).toEqual(CORPUS_IDS);
  });

  it("returns the corpus list from the bucket when the directory is absent", async () => {
    env.set({ SAMPLE_EMAILS_DIR: NO_SUCH_DIR });
    installBucket({ "samples/01-a.json": sample("01-a") });
    const resp = await GET(new Request("http://x/api/pipeline/samples"));
    expect(resp.status).toBe(200);
    expect(((await resp.json()) as { id: string }[]).map((s) => s.id)).toEqual(["01-a"]);
  });

  it("reports a failed read as a 500 naming the cause, not as an empty list", async () => {
    env.set({ SAMPLE_EMAILS_DIR: NO_SUCH_DIR });
    s3Send.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    const resp = await GET(new Request("http://x/api/pipeline/samples"));
    expect(resp.status).toBe(500);
    expect(((await resp.json()) as { error: string }).error).toMatch(/samples list failed: denied/);
  });

  it("honours an authorization refusal", async () => {
    requireActor.mockResolvedValue(refused(401, "no token"));
    const resp = await GET(new Request("http://x/api/pipeline/samples"));
    expect(resp.status).toBe(401);
  });
});

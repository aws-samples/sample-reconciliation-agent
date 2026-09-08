// @vitest-environment node
/**
 * Tests for `/api/recon/lambda-src`, the Config tab's read-only source viewer.
 *
 * The thing worth pinning down is the `?src=` dispatch: three code surfaces are seeded under three
 * different S3 prefixes, and picking the wrong one silently shows the operator the wrong code —
 * which is worse than showing nothing, because the whole point of the viewer is auditability.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const s3Send = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  ListObjectsV2Command: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "List", ...i })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
}));

const { GET } = await import("@/app/api/recon/lambda-src/route");

/** Stand in for S3: list the given keys, then return each key's name as its body. */
function seed(keys: string[]) {
  s3Send.mockImplementation(async (cmd: Record<string, unknown>) => {
    if (cmd.__cmd === "List") return { Contents: keys.map((Key) => ({ Key })) };
    return { Body: { transformToString: async () => `# ${cmd.Key}` } };
  });
}

function get(query = "") {
  return GET(new Request(`http://x/api/recon/lambda-src${query}`));
}

/** The Prefix the route asked S3 to list. */
function listedPrefix(): string {
  const call = s3Send.mock.calls.find((c) => c[0].__cmd === "List");
  return call?.[0].Prefix;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/recon/lambda-src", () => {
  it("defaults to the Tier-1 prefix and strips it from the returned paths", async () => {
    seed(["lambda-src/tier1/handler.py", "lambda-src/tier1/classify.py"]);
    const body = await (await get()).json();
    expect(listedPrefix()).toBe("lambda-src/tier1/");
    // Sorted, and prefix-relative so the viewer's tabs read as plain filenames.
    expect(body.map((f: { path: string }) => f.path)).toEqual([
      "classify.py",
      "handler.py",
    ]);
  });

  it("serves classify.py, the file that stamps tier1_break_type", async () => {
    // Regression: classify.py was missing from the seeded set, so the rule table that decides the
    // break type was the one piece of Tier-1 an operator could not read in the UI.
    seed(["lambda-src/tier1/classify.py"]);
    const body = await (await get()).json();
    expect(body).toEqual([
      { path: "classify.py", content: "# lambda-src/tier1/classify.py" },
    ]);
  });

  it("?src=agent lists the container agent prefix", async () => {
    seed(["lambda-src/agent/agent.py"]);
    await get("?src=agent");
    expect(listedPrefix()).toBe("lambda-src/agent/");
  });

  it("?src=guard lists the gateway interceptor prefix", async () => {
    seed(["lambda-src/guard/handler.py"]);
    const body = await (await get("?src=guard")).json();
    expect(listedPrefix()).toBe("lambda-src/guard/");
    expect(body.map((f: { path: string }) => f.path)).toEqual(["handler.py"]);
  });

  it("falls back to Tier-1 for an unrecognized src", async () => {
    seed(["lambda-src/tier1/handler.py"]);
    await get("?src=nonsense");
    expect(listedPrefix()).toBe("lambda-src/tier1/");
  });

  it("skips directory placeholder keys", async () => {
    seed(["lambda-src/tier1/", "lambda-src/tier1/handler.py"]);
    const body = await (await get()).json();
    expect(body).toHaveLength(1);
  });

  it("reports a read failure as a 500 rather than an empty file list", async () => {
    // An empty list means "nothing published"; a silent empty list on an S3 error would read as
    // that, hiding a broken deploy behind a plausible-looking UI.
    s3Send.mockRejectedValue(new Error("AccessDenied"));
    const res = await get();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("AccessDenied");
  });
});

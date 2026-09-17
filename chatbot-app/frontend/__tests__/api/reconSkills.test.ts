// @vitest-environment node
/**
 * `/api/recon/skills`, `/api/recon/skills/[name]` and `/api/recon/system-prompt` — the recon agent's
 * live skills catalogue and its shared system prompt.
 *
 * Written ahead of the shared skills store (docs/shared-spine-proposal.md §8a) to pin what these three
 * routes do today, row by row of that section's table:
 *
 *   - the catalogue is every `*.md` object under the prefix, metadata only (no `key`, no body), in the
 *     order the listing gives it;
 *   - a read by name answers 404 "not found" on ANY failure, an access denial included;
 *   - a create on the collection is a `PUT` that silently overwrites an existing skill (200, never 409);
 *   - a delete refuses the `unknown` fallback skill before any S3 call;
 *   - the system prompt reads as `{ content: "" }` on ANY failure, and an empty prompt may be written;
 *   - the bucket, prefix and prompt key default to `recon-dev-assets`, `skills/` and
 *     `system-prompt.md` when the environment is unset, and follow it when set;
 *   - error bodies carry the raw S3 message — prefixed with `skills list failed: ` on the catalogue,
 *     bare everywhere else;
 *   - and NO authorization gate runs inside the route (8a, option 1): the proxy's access group is the
 *     only gate, as it has always been for these routes.
 *
 * Every case must still pass, unchanged, once the routes read through the shared store.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { s3Module } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeS3 } from "../helpers/fakeS3";
import { jsonRequest, routeParams } from "../helpers/http";

// Unset on purpose: the defaults are part of the contract. Cleared again before every case so the two
// cases that set them cannot leak into a neighbour whatever order the cases run in.
const env = scopedEnv({
  AWS_REGION: undefined,
  ASSETS_BUCKET: undefined,
  SKILLS_PREFIX: undefined,
  SYSTEM_PROMPT_KEY: undefined,
});
afterAll(() => env.restore());

const s3Send = vi.fn();

// Every gate the console has. None of them may run inside these routes; the `afterEach` below is the
// assertion. Mocked with factories that define ONLY these names, so a route that started importing
// anything else from the auth modules would fail to load here rather than silently pass.
const requireActor = vi.fn();
const authorizeRequest = vi.fn();
const requireAppActor = vi.fn();
const requireAppAdmin = vi.fn();
const requireReconAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor, authorizeRequest }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppActor, requireAppAdmin }));
vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin }));
vi.mock("@aws-sdk/client-s3", () => s3Module(s3Send));

const skills = await import("@/app/api/recon/skills/route");
const skillByName = await import("@/app/api/recon/skills/[name]/route");
const prompt = await import("@/app/api/recon/system-prompt/route");

const RECORD_MATCH = `---
name: record-match-review
description: Compare the ledger record with the counterparty notice field by field.
tools: [general-ledger___search_ledger, managed-kb___Retrieve]
model: us.anthropic.claude-sonnet-5
---
Walk the fields in order and note every mismatch.`;

const UNKNOWN = `---
name: unknown
description: Fallback when no other procedure applies.
---
Report what was found and stop.`;

/** A markdown note that is NOT in the directory-per-skill layout; recon's catalogue lists it anyway. */
const HOW_TO = `---
name: how-to-write-skills
description: Notes for authors.
tools: []
---
Keep procedures short.`;

const bucket = createFakeS3();
const objects = bucket.objects;
s3Send.mockImplementation(bucket.send);

/** Every command handed to the mocked client carrying `tag`. */
function sent(tag: string) {
  return s3Send.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === tag);
}

function accessDenied() {
  return Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
}

const COLLECTION = "http://x/api/recon/skills";
const byName = (name: string) => routeParams({ name });

beforeEach(() => {
  vi.clearAllMocks();
  env.clear();
  bucket.reset({
    "skills/record-match-review/SKILL.md": RECORD_MATCH,
    "skills/record-match-review/examples.txt": "not markdown, not listed",
    "skills/notes/how-to.md": HOW_TO,
    "skills/unknown/SKILL.md": UNKNOWN,
    "system-prompt.md": "You reconcile trades.",
  });
});

afterEach(() => {
  // Decision 8a, option 1: these routes stay ungated. The proxy's access group is the only gate.
  expect(requireActor).not.toHaveBeenCalled();
  expect(authorizeRequest).not.toHaveBeenCalled();
  expect(requireAppActor).not.toHaveBeenCalled();
  expect(requireAppAdmin).not.toHaveBeenCalled();
  expect(requireReconAdmin).not.toHaveBeenCalled();
});

describe("GET /api/recon/skills", () => {
  it("lists every markdown object under the prefix, metadata only, in the listing's order", async () => {
    const resp = await skills.GET();
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // Three `.md` objects, one of them outside the `<name>/SKILL.md` layout; the `.txt` is skipped.
    // Named by frontmatter, not by directory, and in the order S3 listed them — the route does not sort.
    expect(body).toEqual([
      {
        name: "record-match-review",
        description:
          "Compare the ledger record with the counterparty notice field by field.",
        tools: ["general-ledger___search_ledger", "managed-kb___Retrieve"],
        model: "us.anthropic.claude-sonnet-5",
      },
      {
        name: "how-to-write-skills",
        description: "Notes for authors.",
        tools: [],
        model: null,
      },
      {
        name: "unknown",
        description: "Fallback when no other procedure applies.",
        tools: [],
        model: null,
      },
    ]);
    for (const entry of body) {
      expect(entry).not.toHaveProperty("key");
      expect(entry).not.toHaveProperty("body");
    }

    // Defaults when the environment is unset: the recon dev bucket and the `skills/` prefix.
    expect(sent("List")).toEqual([
      { __cmd: "List", Bucket: "recon-dev-assets", Prefix: "skills/" },
    ]);
    expect(sent("GetObject").map((c) => c.Key)).toEqual([
      "skills/record-match-review/SKILL.md",
      "skills/notes/how-to.md",
      "skills/unknown/SKILL.md",
    ]);
  });

  it("answers 500 with the prefixed S3 message when the listing fails", async () => {
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await skills.GET();
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({
      error: "skills list failed: Access Denied",
    });
  });

  it("reads the bucket and prefix from ASSETS_BUCKET and SKILLS_PREFIX", async () => {
    env.set({
      ASSETS_BUCKET: "recon-prod-assets",
      SKILLS_PREFIX: "agent/skills/",
    });
    vi.resetModules();
    const fresh = await import("@/app/api/recon/skills/route");
    objects["agent/skills/unknown/SKILL.md"] = UNKNOWN;

    const body = await (await fresh.GET()).json();

    expect(sent("List")).toEqual([
      { __cmd: "List", Bucket: "recon-prod-assets", Prefix: "agent/skills/" },
    ]);
    expect(body.map((s: { name: string }) => s.name)).toEqual(["unknown"]);
  });
});

describe("PUT /api/recon/skills (create)", () => {
  const content = `---
name: fee-break-review
description: Trace a fee difference to its schedule.
tools: [general-ledger___search_ledger]
---
Find the fee schedule first.`;

  it("writes <prefix><name>/SKILL.md as markdown and answers 200 { name }", async () => {
    const resp = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { name: "fee-break-review", content }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ name: "fee-break-review" });
    expect(sent("PutObject")).toEqual([
      {
        __cmd: "PutObject",
        Bucket: "recon-dev-assets",
        Key: "skills/fee-break-review/SKILL.md",
        Body: content,
        ContentType: "text/markdown",
      },
    ]);
    expect(objects["skills/fee-break-review/SKILL.md"]).toBe(content);
  });

  it("silently overwrites a skill that already exists", async () => {
    // No existence check and no 409: the collection PUT is create-or-replace.
    const replaced = `---
name: unknown
description: Fallback, rewritten.
---
Stop.`;
    const resp = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { name: "unknown", content: replaced }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ name: "unknown" });
    expect(objects["skills/unknown/SKILL.md"]).toBe(replaced);
    expect(sent("GetObject")).toEqual([]);
  });

  it("400s a missing name or content, a non-JSON body, and a frontmatter that does not validate", async () => {
    const missingName = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { content }),
    );
    expect(missingName.status).toBe(400);
    expect(await missingName.json()).toEqual({
      error: "name and content required",
    });

    const missingContent = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { name: "fee-break-review" }),
    );
    expect(missingContent.status).toBe(400);

    const notJson = await skills.PUT(
      jsonRequest("PUT", COLLECTION, "{not json", { raw: true }),
    );
    expect(notJson.status).toBe(400);

    const mismatch = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { name: "other-name", content }),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: "frontmatter name 'fee-break-review' must equal 'other-name'",
    });

    const badName = await skills.PUT(
      jsonRequest("PUT", COLLECTION, {
        name: "Fee Break",
        content: content.replace("fee-break-review", "Fee Break"),
      }),
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({
      error: "name must match ^[a-z0-9-]+$",
    });

    expect(sent("PutObject")).toEqual([]);
  });

  it("answers 500 with the raw S3 message when the write fails", async () => {
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await skills.PUT(
      jsonRequest("PUT", COLLECTION, { name: "fee-break-review", content }),
    );
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "Access Denied" });
  });
});

describe("GET /api/recon/skills/[name]", () => {
  it("returns the raw SKILL.md from <prefix><name>/SKILL.md", async () => {
    const resp = await skillByName.GET(
      jsonRequest("GET", "http://x/x"),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      name: "record-match-review",
      content: RECORD_MATCH,
    });
    expect(sent("GetObject")).toEqual([
      {
        __cmd: "GetObject",
        Bucket: "recon-dev-assets",
        Key: "skills/record-match-review/SKILL.md",
      },
    ]);
  });

  it("answers 404 'not found' for a skill that does not exist", async () => {
    const resp = await skillByName.GET(
      jsonRequest("GET", "http://x/x"),
      byName("nope"),
    );
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "not found" });
  });

  it("answers 404 for ANY read failure, an access denial included", async () => {
    // A permissions problem is indistinguishable from a missing skill here. That is the contract the
    // Skills tab was built against, and the shared store must keep it for recon.
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await skillByName.GET(
      jsonRequest("GET", "http://x/x"),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({ error: "not found" });
  });
});

describe("PUT /api/recon/skills/[name]", () => {
  const edited = `${RECORD_MATCH}\nThen check the settlement date.`;

  it("replaces the skill after validating the frontmatter against the route name", async () => {
    const resp = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", { content: edited }),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ name: "record-match-review" });
    expect(sent("PutObject")).toEqual([
      {
        __cmd: "PutObject",
        Bucket: "recon-dev-assets",
        Key: "skills/record-match-review/SKILL.md",
        Body: edited,
        ContentType: "text/markdown",
      },
    ]);
    // Written byte for byte: no trimming of the trailing text the author typed.
    expect(objects["skills/record-match-review/SKILL.md"]).toBe(edited);
  });

  it("400s an absent or empty content and a frontmatter mismatch, writing nothing", async () => {
    const absent = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", {}),
      byName("record-match-review"),
    );
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: "content required" });

    const empty = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", { content: "" }),
      byName("record-match-review"),
    );
    expect(empty.status).toBe(400);

    const mismatch = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", { content: edited }),
      byName("other-skill"),
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: "frontmatter name 'record-match-review' must equal 'other-skill'",
    });

    expect(sent("PutObject")).toEqual([]);
    expect(objects["skills/record-match-review/SKILL.md"]).toBe(RECORD_MATCH);
  });

  it("answers 500 with the raw S3 message when the write fails", async () => {
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", { content: edited }),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "Access Denied" });
  });
});

describe("DELETE /api/recon/skills/[name]", () => {
  it("refuses to delete the `unknown` fallback skill before touching S3", async () => {
    const resp = await skillByName.DELETE(
      jsonRequest("DELETE", "http://x/x"),
      byName("unknown"),
    );
    expect(resp.status).toBe(400);
    expect(await resp.json()).toEqual({
      error: "the 'unknown' fallback skill cannot be deleted",
    });
    expect(s3Send).not.toHaveBeenCalled();
    expect(objects["skills/unknown/SKILL.md"]).toBe(UNKNOWN);
  });

  it("deletes <prefix><name>/SKILL.md and answers { deleted }", async () => {
    const resp = await skillByName.DELETE(
      jsonRequest("DELETE", "http://x/x"),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ deleted: "record-match-review" });
    expect(sent("Delete")).toEqual([
      {
        __cmd: "Delete",
        Bucket: "recon-dev-assets",
        Key: "skills/record-match-review/SKILL.md",
      },
    ]);
    expect(objects["skills/record-match-review/SKILL.md"]).toBeUndefined();
  });

  it("answers 500 with the raw S3 message when the delete fails", async () => {
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await skillByName.DELETE(
      jsonRequest("DELETE", "http://x/x"),
      byName("record-match-review"),
    );
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "Access Denied" });
  });
});

describe("GET /api/recon/system-prompt", () => {
  it("returns the prompt from system-prompt.md in the assets bucket by default", async () => {
    const resp = await prompt.GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ content: "You reconcile trades." });
    expect(sent("GetObject")).toEqual([
      {
        __cmd: "GetObject",
        Bucket: "recon-dev-assets",
        Key: "system-prompt.md",
      },
    ]);
  });

  it("answers 200 { content: '' } when the prompt has not been set", async () => {
    delete objects["system-prompt.md"];
    const resp = await prompt.GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ content: "" });
  });

  it("answers 200 { content: '' } on ANY read failure, an access denial included", async () => {
    // Not a 404 and not a 500: the editor opens empty and the agent falls back to its built-in prompt.
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await prompt.GET();
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ content: "" });
  });

  it("reads the key from SYSTEM_PROMPT_KEY and the bucket from ASSETS_BUCKET", async () => {
    env.set({
      ASSETS_BUCKET: "recon-prod-assets",
      SYSTEM_PROMPT_KEY: "prompts/recon.md",
    });
    vi.resetModules();
    const fresh = await import("@/app/api/recon/system-prompt/route");
    objects["prompts/recon.md"] = "Prod prompt.";

    expect(await (await fresh.GET()).json()).toEqual({
      content: "Prod prompt.",
    });
    expect(sent("GetObject")).toEqual([
      {
        __cmd: "GetObject",
        Bucket: "recon-prod-assets",
        Key: "prompts/recon.md",
      },
    ]);
  });
});

describe("PUT /api/recon/system-prompt", () => {
  it("writes the prompt as markdown and answers { ok: true }", async () => {
    const resp = await prompt.PUT(
      jsonRequest("PUT", "http://x/x", { content: "Reconcile carefully." }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(sent("PutObject")).toEqual([
      {
        __cmd: "PutObject",
        Bucket: "recon-dev-assets",
        Key: "system-prompt.md",
        Body: "Reconcile carefully.",
        ContentType: "text/markdown",
      },
    ]);
    expect(objects["system-prompt.md"]).toBe("Reconcile carefully.");
  });

  it("accepts an empty prompt", async () => {
    // Clearing the prompt is a legitimate edit: the agent then runs on its built-in framing.
    const resp = await prompt.PUT(
      jsonRequest("PUT", "http://x/x", { content: "" }),
    );
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(sent("PutObject")).toHaveLength(1);
    expect(objects["system-prompt.md"]).toBe("");
  });

  it("400s when content is absent or the body is not JSON, writing nothing", async () => {
    const absent = await prompt.PUT(jsonRequest("PUT", "http://x/x", {}));
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: "content required" });

    const notJson = await prompt.PUT(
      jsonRequest("PUT", "http://x/x", "{not json", { raw: true }),
    );
    expect(notJson.status).toBe(400);

    expect(sent("PutObject")).toEqual([]);
    expect(objects["system-prompt.md"]).toBe("You reconcile trades.");
  });

  it("answers 500 with the raw S3 message when the write fails", async () => {
    s3Send.mockRejectedValueOnce(accessDenied());
    const resp = await prompt.PUT(
      jsonRequest("PUT", "http://x/x", { content: "x" }),
    );
    expect(resp.status).toBe(500);
    expect(await resp.json()).toEqual({ error: "Access Denied" });
  });
});

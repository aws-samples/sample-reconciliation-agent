// @vitest-environment node
/**
 * `/api/pipeline/skills/**` — the catalog, one skill, the parser prompt, and skill proposals.
 *
 * The proposal decision is the contract that matters most: approve is the ONLY path by which the
 * assistant's suggestions reach `skills/` in S3, so it must write exactly the proposed content to
 * the directory-per-skill key, must refuse content the parser could not load, and must not run
 * twice.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

process.env.AWS_REGION = "us-east-1";
process.env.PIPELINE_ASSETS_BUCKET = "test-assets";
process.env.SKILL_PROPOSALS_TABLE = "test-proposals";
process.env.PIPELINE_SKILLS_PREFIX = "skills/";
process.env.PARSER_PROMPT_KEY = "prompts/parser-system.md";

const ddbSend = vi.fn();
const s3Send = vi.fn();
const requireActor = vi.fn();
const requirePipelineAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/pipelineAdmin", () => ({ requirePipelineAdmin }));
vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetItem", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutItem", ...i })),
  ScanCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Scan", ...i })),
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn().mockImplementation(() => ({ send: s3Send })),
  GetObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "GetObject", ...i })),
  PutObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "PutObject", ...i })),
  ListObjectsV2Command: vi.fn().mockImplementation((i) => ({ __cmd: "List", ...i })),
  DeleteObjectCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Delete", ...i })),
}));

const skills = await import("@/app/api/pipeline/skills/route");
const skillByName = await import("@/app/api/pipeline/skills/[name]/route");
const prompt = await import("@/app/api/pipeline/skills/system-prompt/route");
const proposals = await import("@/app/api/pipeline/skills/proposals/route");
const proposalById = await import("@/app/api/pipeline/skills/proposals/[id]/route");
type SkillProposal = import("@/lib/pipeline/types").SkillProposal;

const CURRENT = `---
name: deal-parsing
description: Stage new-issue deal emails as OMS records.
---
Term loans are Loan records.`;
const PROPOSED = `${CURRENT}
Loan records always carry Covenant Status #; cov-lite is 3.
Arranger names use the OMS canonical counterparty list.`;

/** In-memory S3 objects and proposals table behind the mocks. */
let objects: Record<string, string>;
let table: Record<string, SkillProposal>;
function installFakes() {
  objects = {};
  table = {};
  s3Send.mockImplementation(async (cmd: { __cmd: string; Key: string; Body?: string; Prefix?: string }) => {
    if (cmd.__cmd === "GetObject") {
      if (!(cmd.Key in objects)) throw Object.assign(new Error("nsk"), { name: "NoSuchKey" });
      return { Body: { transformToString: async () => objects[cmd.Key] } };
    }
    if (cmd.__cmd === "PutObject") {
      objects[cmd.Key] = cmd.Body ?? "";
      return {};
    }
    if (cmd.__cmd === "Delete") {
      delete objects[cmd.Key];
      return {};
    }
    if (cmd.__cmd === "List") {
      return {
        Contents: Object.keys(objects)
          .filter((k) => k.startsWith(cmd.Prefix ?? ""))
          .map((Key) => ({ Key })),
      };
    }
    throw new Error(`unexpected ${cmd.__cmd}`);
  });
  ddbSend.mockImplementation(async (cmd: { __cmd: string; Key?: never; Item?: never }) => {
    if (cmd.__cmd === "GetItem") {
      const key = unmarshall(cmd.Key!).proposal_id as string;
      return { Item: table[key] ? marshall(table[key], { removeUndefinedValues: true }) : undefined };
    }
    if (cmd.__cmd === "PutItem") {
      const item = unmarshall(cmd.Item!) as SkillProposal;
      table[item.proposal_id] = item;
      return {};
    }
    if (cmd.__cmd === "Scan") {
      return { Items: Object.values(table).map((i) => marshall(i, { removeUndefinedValues: true })) };
    }
    throw new Error(`unexpected ${cmd.__cmd}`);
  });
}

function pending(): SkillProposal {
  return {
    proposal_id: "sp_1",
    skill_name: "deal-parsing",
    summary: "Loans always carry Covenant Status #; arrangers use canonical names",
    rationale: "COVENANT_STATUS_REQUIRED and LEFT_AGENT_UNKNOWN on the Copperfield deal.",
    proposed_content: PROPOSED,
    current_content: CURRENT,
    status: "PENDING",
    source: { kind: "assistant", session_id: "s1", deal_id: "dl_1" },
    created_at: "2026-08-13T10:10:00Z",
  };
}

const params = (v: string, key = "id") => ({ params: Promise.resolve({ [key]: v }) as never });
function json(method: string, url: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const decide = (id: string, decision: unknown) =>
  proposalById.POST(json("POST", `http://x/api/pipeline/skills/proposals/${id}`, { decision }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  installFakes();
  objects["skills/deal-parsing/SKILL.md"] = CURRENT;
  objects["skills/README.md"] = "not a skill";
  table.sp_1 = pending();
  requireActor.mockResolvedValue({ actor: "reviewer" });
  requirePipelineAdmin.mockResolvedValue({ actor: "admin-1" });
});

describe("POST /api/pipeline/skills/proposals/[id]", () => {
  it("approve writes the proposed SKILL.md to S3 and marks the proposal APPROVED", async () => {
    const resp = await decide("sp_1", "approve");
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as SkillProposal;
    expect(body).toMatchObject({ status: "APPROVED", decided_by: "admin-1" });
    expect(body.decided_at).toBeTruthy();

    const put = s3Send.mock.calls.find((c) => c[0].__cmd === "PutObject")![0];
    expect(put).toMatchObject({
      Bucket: "test-assets",
      Key: "skills/deal-parsing/SKILL.md",
      ContentType: "text/markdown",
      Body: PROPOSED,
    });
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(PROPOSED);
    expect(table.sp_1.status).toBe("APPROVED");
    // S3 before DynamoDB: a failed write must leave the proposal PENDING and retryable.
    expect(s3Send.mock.invocationCallOrder[0]).toBeLessThan(
      ddbSend.mock.invocationCallOrder[ddbSend.mock.calls.length - 1],
    );
  });

  it("reject marks REJECTED and leaves S3 alone", async () => {
    const body = await (await decide("sp_1", "reject")).json();
    expect(body.status).toBe("REJECTED");
    expect(s3Send.mock.calls.some((c) => c[0].__cmd === "PutObject")).toBe(false);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(CURRENT);
  });

  it("409s a proposal that is already decided", async () => {
    table.sp_1 = { ...pending(), status: "APPROVED" };
    expect((await decide("sp_1", "approve")).status).toBe(409);
    expect(s3Send.mock.calls.some((c) => c[0].__cmd === "PutObject")).toBe(false);
  });

  it("409s an approve when the skill changed since the proposal's snapshot, writing nothing", async () => {
    // The proposal's content was derived from CURRENT; an admin edited the skill on the Skills tab
    // in between. Approving would silently discard that edit, and the diff the admin saw would not
    // be the change that landed.
    const edited = `${CURRENT}\nBond records are Fixed.`;
    objects["skills/deal-parsing/SKILL.md"] = edited;
    const resp = await decide("sp_1", "approve");
    expect(resp.status).toBe(409);
    expect((await resp.json()).error).toMatch(/^skill changed since the proposal was made/);
    expect(s3Send.mock.calls.some((c) => c[0].__cmd === "PutObject")).toBe(false);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(edited);
    expect(table.sp_1.status).toBe("PENDING"); // still decidable once re-proposed or rejected
  });

  it("applies the first of two pending proposals for one skill and 409s the second", async () => {
    table.sp_2 = { ...pending(), proposal_id: "sp_2", proposed_content: `${CURRENT}\nBond records are Fixed.` };
    expect((await decide("sp_1", "approve")).status).toBe(200);
    expect((await decide("sp_2", "approve")).status).toBe(409);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(PROPOSED);
    expect(table.sp_2.status).toBe("PENDING");
    // Rejecting the stale one needs no snapshot check: nothing is written to S3.
    expect((await decide("sp_2", "reject")).status).toBe(200);
  });

  it("approves a proposal for a skill that did not exist yet (snapshot \"\" matches no object)", async () => {
    const content = "---\nname: bond-rules\ndescription: Bonds are Fixed.\n---\nBody";
    table.sp_3 = { ...pending(), proposal_id: "sp_3", skill_name: "bond-rules", current_content: "", proposed_content: content };
    expect((await decide("sp_3", "approve")).status).toBe(200);
    expect(objects["skills/bond-rules/SKILL.md"]).toBe(content);
  });

  it("refuses to approve content the parser could not load as a skill", async () => {
    table.sp_1 = { ...pending(), proposed_content: "no frontmatter at all" };
    const resp = await decide("sp_1", "approve");
    expect(resp.status).toBe(400);
    expect((await resp.json()).error).toMatch(/not a valid skill/);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(CURRENT);
  });

  it("400s a bad decision, 404s an unknown id, and honours the admin gate", async () => {
    expect((await decide("sp_1", "maybe")).status).toBe(400);
    expect((await decide("sp_9", "approve")).status).toBe(404);
    const { NextResponse } = await import("next/server");
    requirePipelineAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });
    expect((await decide("sp_1", "approve")).status).toBe(403);
  });
});

describe("/api/pipeline/skills/proposals", () => {
  it("lists newest first and reads one", async () => {
    table.sp_2 = { ...pending(), proposal_id: "sp_2", created_at: "2026-08-14T10:10:00Z" };
    const list = await (await proposals.GET(json("GET", "http://x/api/pipeline/skills/proposals"))).json();
    expect(list.map((p: SkillProposal) => p.proposal_id)).toEqual(["sp_2", "sp_1"]);
    const one = await proposalById.GET(json("GET", "http://x/x"), params("sp_1"));
    expect((await one.json()).proposal_id).toBe("sp_1");
    expect((await proposalById.GET(json("GET", "http://x/x"), params("sp_9"))).status).toBe(404);
  });

  it("creates a manual proposal with a snapshot of the current skill", async () => {
    const resp = await proposals.POST(
      json("POST", "http://x/api/pipeline/skills/proposals", {
        skill_name: "deal-parsing",
        summary: "Bond records are Fixed",
        proposed_content: PROPOSED,
      }),
    );
    expect(resp.status).toBe(201);
    const body = (await resp.json()) as SkillProposal;
    expect(body).toMatchObject({
      status: "PENDING",
      source: { kind: "manual" },
      current_content: CURRENT,
      rationale: "",
    });
    expect(body.proposal_id).toMatch(/^sp_/);
    expect(table[body.proposal_id]).toBeTruthy();
  });

  it("refuses a manual proposal that could never be approved", async () => {
    const resp = await proposals.POST(
      json("POST", "http://x/api/pipeline/skills/proposals", {
        skill_name: "deal-parsing",
        summary: "s",
        proposed_content: "---\nname: other\ndescription: d\n---\nbody",
      }),
    );
    expect(resp.status).toBe(400);
    expect(ddbSend).not.toHaveBeenCalled();
  });
});

describe("/api/pipeline/skills and /skills/[name]", () => {
  it("lists only SKILL.md objects, naming each by its directory", async () => {
    objects["skills/left-agent-names/SKILL.md"] = "---\nname: wrong-name\ndescription: Canonical arrangers.\n---\n";
    const body = await (await skills.GET(json("GET", "http://x/api/pipeline/skills"))).json();
    expect(body.map((s: { name: string }) => s.name)).toEqual(["deal-parsing", "left-agent-names"]);
    expect(body[0]).toMatchObject({
      description: "Stage new-issue deal emails as OMS records.",
      key: "skills/deal-parsing/SKILL.md",
      tools: [],
      model: null,
    });
  });

  it("creates a new skill once, then refuses to clobber it", async () => {
    const content = "---\nname: bond-rules\ndescription: Bonds are Fixed.\n---\nBody";
    const create = await skills.PUT(json("PUT", "http://x/api/pipeline/skills", { name: "bond-rules", content }));
    expect(create.status).toBe(201);
    expect(objects["skills/bond-rules/SKILL.md"]).toBe(content);
    const again = await skills.PUT(json("PUT", "http://x/api/pipeline/skills", { name: "bond-rules", content }));
    expect(again.status).toBe(409);
    const bad = await skills.PUT(json("PUT", "http://x/api/pipeline/skills", { name: "Bad Name", content }));
    expect(bad.status).toBe(400);
  });

  it("reads, replaces and deletes one skill, validating the name and frontmatter", async () => {
    const got = await skillByName.GET(json("GET", "http://x/x"), params("deal-parsing", "name"));
    expect(await got.json()).toEqual({ name: "deal-parsing", content: CURRENT });
    expect((await skillByName.GET(json("GET", "http://x/x"), params("nope", "name"))).status).toBe(404);
    expect((await skillByName.GET(json("GET", "http://x/x"), params("../etc", "name"))).status).toBe(400);

    const mismatch = await skillByName.PUT(
      json("PUT", "http://x/x", { content: PROPOSED }),
      params("other-skill", "name"),
    );
    expect(mismatch.status).toBe(400);
    const ok = await skillByName.PUT(json("PUT", "http://x/x", { content: PROPOSED }), params("deal-parsing", "name"));
    expect(ok.status).toBe(200);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(PROPOSED);

    const del = await skillByName.DELETE(json("DELETE", "http://x/x"), params("deal-parsing", "name"));
    expect(await del.json()).toEqual({ deleted: "deal-parsing" });
    expect(objects["skills/deal-parsing/SKILL.md"]).toBeUndefined();
  });
});

describe("/api/pipeline/skills/system-prompt", () => {
  it("404s until seeded, then round-trips the prompt", async () => {
    expect((await prompt.GET(json("GET", "http://x/x"))).status).toBe(404);
    const put = await prompt.PUT(json("PUT", "http://x/x", { content: "You stage deals." }));
    expect(await put.json()).toEqual({ key: "prompts/parser-system.md" });
    expect(objects["prompts/parser-system.md"]).toBe("You stage deals.");
    expect(await (await prompt.GET(json("GET", "http://x/x"))).json()).toEqual({
      key: "prompts/parser-system.md",
      content: "You stage deals.",
    });
    expect((await prompt.PUT(json("PUT", "http://x/x", {}))).status).toBe(400);
  });
});

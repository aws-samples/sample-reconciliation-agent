// @vitest-environment node
/**
 * `/api/pipeline/skills/**` — the catalog, one skill, the parser prompt, and skill proposals.
 *
 * The proposal decision is the contract that matters most: approve is the ONLY path by which the
 * assistant's suggestions reach `skills/` in S3, so it must write exactly the proposed content to
 * the directory-per-skill key, must refuse content the parser could not load, and must not run
 * twice.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { dynamoDbModule, s3Module } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { createFakeTable } from "../helpers/fakeDdb";
import { createFakeS3 } from "../helpers/fakeS3";
import { admitted, refused } from "../helpers/gates";
import { jsonRequest, routeParams } from "../helpers/http";

const env = scopedEnv({
  AWS_REGION: "us-east-1",
  PIPELINE_ASSETS_BUCKET: "test-assets",
  SKILL_PROPOSALS_TABLE: "test-proposals",
  PIPELINE_SKILLS_PREFIX: "skills/",
  PARSER_PROMPT_KEY: "prompts/parser-system.md",
});
afterAll(() => env.restore());

const ddbSend = vi.fn();
const s3Send = vi.fn();
const requireActor = vi.fn();
const requireAppAdmin = vi.fn();

vi.mock("@/lib/api-auth", () => ({ requireActor }));
vi.mock("@/lib/auth/app-admin", () => ({ requireAppAdmin }));
vi.mock("@aws-sdk/client-dynamodb", () => dynamoDbModule(ddbSend));
vi.mock("@aws-sdk/client-s3", () => s3Module(s3Send));

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
const bucket = createFakeS3();
const objects = bucket.objects;
const proposalsTable = createFakeTable<SkillProposal>({ keyAttr: "proposal_id" });
const table = proposalsTable.rows;
s3Send.mockImplementation(bucket.send);
ddbSend.mockImplementation(proposalsTable.send);

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

const decide = (id: string, decision: unknown) =>
  proposalById.POST(jsonRequest("POST", `http://x/api/pipeline/skills/proposals/${id}`, { decision }), routeParams({ id }));

beforeEach(() => {
  vi.clearAllMocks();
  bucket.reset();
  proposalsTable.reset();
  objects["skills/deal-parsing/SKILL.md"] = CURRENT;
  objects["skills/README.md"] = "not a skill";
  table.sp_1 = pending();
  requireActor.mockResolvedValue(admitted("reviewer"));
  requireAppAdmin.mockResolvedValue(admitted("admin-1"));
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
    requireAppAdmin.mockResolvedValue(refused(403, "not an admin"));
    expect((await decide("sp_1", "approve")).status).toBe(403);
  });
});

describe("/api/pipeline/skills/proposals", () => {
  it("lists newest first and reads one", async () => {
    table.sp_2 = { ...pending(), proposal_id: "sp_2", created_at: "2026-08-14T10:10:00Z" };
    const list = await (await proposals.GET(jsonRequest("GET", "http://x/api/pipeline/skills/proposals"))).json();
    expect(list.map((p: SkillProposal) => p.proposal_id)).toEqual(["sp_2", "sp_1"]);
    const one = await proposalById.GET(jsonRequest("GET", "http://x/x"), routeParams({ id: "sp_1" }));
    expect((await one.json()).proposal_id).toBe("sp_1");
    expect((await proposalById.GET(jsonRequest("GET", "http://x/x"), routeParams({ id: "sp_9" }))).status).toBe(404);
  });

  it("creates a manual proposal with a snapshot of the current skill", async () => {
    const resp = await proposals.POST(
      jsonRequest("POST", "http://x/api/pipeline/skills/proposals", {
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
      jsonRequest("POST", "http://x/api/pipeline/skills/proposals", {
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
    const body = await (await skills.GET(jsonRequest("GET", "http://x/api/pipeline/skills"))).json();
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
    const create = await skills.PUT(jsonRequest("PUT", "http://x/api/pipeline/skills", { name: "bond-rules", content }));
    expect(create.status).toBe(201);
    expect(objects["skills/bond-rules/SKILL.md"]).toBe(content);
    const again = await skills.PUT(jsonRequest("PUT", "http://x/api/pipeline/skills", { name: "bond-rules", content }));
    expect(again.status).toBe(409);
    const bad = await skills.PUT(jsonRequest("PUT", "http://x/api/pipeline/skills", { name: "Bad Name", content }));
    expect(bad.status).toBe(400);
  });

  it("reads, replaces and deletes one skill, validating the name and frontmatter", async () => {
    const got = await skillByName.GET(jsonRequest("GET", "http://x/x"), routeParams({ name: "deal-parsing" }));
    expect(await got.json()).toEqual({ name: "deal-parsing", content: CURRENT });
    expect((await skillByName.GET(jsonRequest("GET", "http://x/x"), routeParams({ name: "nope" }))).status).toBe(404);
    expect((await skillByName.GET(jsonRequest("GET", "http://x/x"), routeParams({ name: "../etc" }))).status).toBe(400);

    const mismatch = await skillByName.PUT(
      jsonRequest("PUT", "http://x/x", { content: PROPOSED }),
      routeParams({ name: "other-skill" }),
    );
    expect(mismatch.status).toBe(400);
    const ok = await skillByName.PUT(jsonRequest("PUT", "http://x/x", { content: PROPOSED }), routeParams({ name: "deal-parsing" }));
    expect(ok.status).toBe(200);
    expect(objects["skills/deal-parsing/SKILL.md"]).toBe(PROPOSED);

    const del = await skillByName.DELETE(jsonRequest("DELETE", "http://x/x"), routeParams({ name: "deal-parsing" }));
    expect(await del.json()).toEqual({ deleted: "deal-parsing" });
    expect(objects["skills/deal-parsing/SKILL.md"]).toBeUndefined();
  });
});

describe("/api/pipeline/skills/system-prompt", () => {
  it("404s until seeded, then round-trips the prompt", async () => {
    expect((await prompt.GET(jsonRequest("GET", "http://x/x"))).status).toBe(404);
    const put = await prompt.PUT(jsonRequest("PUT", "http://x/x", { content: "You stage deals." }));
    expect(await put.json()).toEqual({ key: "prompts/parser-system.md" });
    expect(objects["prompts/parser-system.md"]).toBe("You stage deals.");
    expect(await (await prompt.GET(jsonRequest("GET", "http://x/x"))).json()).toEqual({
      key: "prompts/parser-system.md",
      content: "You stage deals.",
    });
    expect((await prompt.PUT(jsonRequest("PUT", "http://x/x", {}))).status).toBe(400);
  });
});

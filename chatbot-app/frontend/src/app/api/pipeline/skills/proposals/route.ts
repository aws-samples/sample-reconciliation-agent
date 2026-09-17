import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { validateSkill } from "@/lib/skillFrontmatter";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";
import { createProposal, listProposals } from "@/lib/pipeline/server/proposalStore";

// Skill proposals: the assistant's suggested SKILL.md rewrites, and manual ones, awaiting a decision.
//
// POST is open to every authenticated user — proposing is how a reviewer who spotted a pattern
// gets it in front of an admin — while the decision on `/skills/proposals/[id]` is admin-gated,
// because that is the write that reaches the parser.
export const runtime = "nodejs";

/** @returns `SkillProposal[]`, newest first. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await listProposals());
  } catch (err) {
    return jsonError(500, `proposals list failed: ${(err as Error).message}`);
  }
}

/**
 * Create a manual proposal: body `{ skill_name, summary, rationale?, proposed_content }`.
 *
 * @returns 201 with the PENDING proposal; 400 when a field is missing or the proposed SKILL.md
 *   would not validate (a proposal that can never be approved is refused up front).
 */
export async function POST(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const body = await readJsonObject(req);
  const skillName = body ? stringField(body, "skill_name") : undefined;
  const summary = body ? stringField(body, "summary") : undefined;
  const content = body ? stringField(body, "proposed_content") : undefined;
  if (!skillName || !summary || !content) {
    return jsonError(400, "skill_name, summary and proposed_content are required");
  }
  const invalid = validateSkill(content, skillName);
  if (invalid) return jsonError(400, invalid);
  try {
    const proposal = await createProposal({
      skill_name: skillName,
      summary,
      rationale: (body && stringField(body, "rationale")) ?? "",
      proposed_content: content,
      source: { kind: "manual" },
    });
    return NextResponse.json(proposal, { status: 201 });
  } catch (err) {
    return jsonError(500, `proposal create failed: ${(err as Error).message}`);
  }
}

import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { validateSkill } from "@/lib/skillFrontmatter";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";
import {
  decideProposal,
  getProposal,
  SKILL_CHANGED_ERROR,
} from "@/lib/pipeline/server/proposalStore";

// One proposal: read it for the diff view, or decide it.
//
// Approval is the only path by which the assistant's suggestions reach `skills/` in S3, which is
// why it is admin-gated, why it refuses a proposal whose content would not load as a skill, and why
// it refuses one whose skill has changed since the proposal was made — the diff the admin approved
// would not be the change that landed.
export const runtime = "nodejs";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { id } = await params;
  try {
    const proposal = await getProposal(id);
    if (!proposal) return jsonError(404, `proposal ${id} not found`);
    return NextResponse.json(proposal);
  } catch (err) {
    return jsonError(500, `proposal read failed: ${(err as Error).message}`);
  }
}

/**
 * Decide a proposal: body `{ decision: "approve" | "reject" }`.
 *
 * @returns the decided proposal; 400 on a bad decision or (approve only) invalid SKILL.md; 404;
 *   409 when the proposal was already decided — a second approve must not rewrite the skill again —
 *   or (approve only) when the live skill no longer matches the snapshot the proposal was built on.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const { id } = await params;
  const body = await readJsonObject(req);
  const decision = body ? stringField(body, "decision") : undefined;
  if (decision !== "approve" && decision !== "reject") {
    return jsonError(400, 'decision must be "approve" or "reject"');
  }
  try {
    const proposal = await getProposal(id);
    if (!proposal) return jsonError(404, `proposal ${id} not found`);
    if (proposal.status !== "PENDING") {
      return jsonError(409, `proposal ${id} is already ${proposal.status}`);
    }
    if (decision === "approve") {
      const invalid = validateSkill(proposal.proposed_content, proposal.skill_name);
      if (invalid) return jsonError(400, `proposed content is not a valid skill: ${invalid}`);
    }
    return NextResponse.json(await decideProposal(proposal, decision, admin.actor));
  } catch (err) {
    // Matched by name, not `instanceof`: the store may be a partial mock under test, and the
    // error's `name` is the part of its contract that is stable either way.
    if ((err as { name?: string } | null)?.name === SKILL_CHANGED_ERROR) {
      return jsonError(409, (err as Error).message);
    }
    return jsonError(500, `proposal decision failed: ${(err as Error).message}`);
  }
}

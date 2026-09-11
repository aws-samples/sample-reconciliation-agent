/**
 * Skill proposals (design §4): the assistant's — or an operator's — suggested SKILL.md rewrite,
 * held for a human decision.
 *
 * This is the whole reason the assistant never writes to `skills/` directly. A rule that applies to
 * every deal changes every future parse, so it gets a diff view and an approve button; the approve
 * is the only path that reaches S3.
 */

import type { SkillProposal } from "@/lib/pipeline/types";
import { getItem, putItem, scanAll } from "./aws";
import { env } from "./env";
import { newProposalId } from "./ids";
import { getSkill, putSkill } from "./skillsStore";

export interface NewProposalInput {
  skill_name: string;
  summary: string;
  rationale: string;
  proposed_content: string;
  source: SkillProposal["source"];
}

/** Proposals, newest first — pending ones surface at the top of the Skills tab. */
export async function listProposals(): Promise<SkillProposal[]> {
  const items = await scanAll<SkillProposal>(env.skillProposalsTable());
  return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getProposal(id: string): Promise<SkillProposal | null> {
  return getItem<SkillProposal>(env.skillProposalsTable(), { proposal_id: id });
}

/**
 * Store a PENDING proposal, snapshotting the skill's current content for the diff view.
 *
 * The snapshot is taken now rather than at decision time because the diff must show what the
 * proposer was looking at; a skill edited in between would otherwise make the proposal look like it
 * reverts changes it never saw. A skill that does not exist yet snapshots as "".
 */
export async function createProposal(
  input: NewProposalInput,
  now: Date = new Date(),
): Promise<SkillProposal> {
  const proposal: SkillProposal = {
    proposal_id: newProposalId(now),
    skill_name: input.skill_name,
    summary: input.summary,
    rationale: input.rationale,
    proposed_content: input.proposed_content,
    current_content: (await getSkill(input.skill_name)) ?? "",
    status: "PENDING",
    source: input.source,
    created_at: now.toISOString(),
  };
  await putItem(env.skillProposalsTable(), proposal);
  return proposal;
}

/**
 * The live SKILL.md no longer matches the snapshot a proposal was built from.
 *
 * Thrown (not returned) so the store's write path cannot be reached past it, and given a stable
 * `name` so the route can map it to 409 without an `instanceof` across module mocks.
 */
export const SKILL_CHANGED_ERROR = "SkillChangedError";

export class SkillChangedError extends Error {
  constructor(skillName: string) {
    super(
      `skill changed since the proposal was made: ${skillName} was edited after this proposal's snapshot; re-propose against the current content`,
    );
    this.name = SKILL_CHANGED_ERROR;
  }
}

/**
 * Decide a pending proposal.
 *
 * Approval first re-reads the live skill and refuses when it differs from `current_content`.
 * `proposed_content` was derived from that snapshot (targeted edits applied to it), so if the skill
 * was edited in between — on the Skills tab, or by approving another proposal for the same skill —
 * writing it would silently discard those edits, and the diff the admin just approved would not be
 * the change that lands. A skill that did not exist at proposal time snapshots as "" and still
 * compares equal to a missing object.
 *
 * Then it writes the proposed content to S3 BEFORE marking the row APPROVED: if the S3 write
 * fails the proposal stays PENDING and can be retried, whereas the other order would show an
 * approved proposal whose skill never changed.
 *
 * @throws SkillChangedError on approve when the live skill no longer matches the snapshot.
 */
export async function decideProposal(
  proposal: SkillProposal,
  decision: "approve" | "reject",
  actor: string,
  now: Date = new Date(),
): Promise<SkillProposal> {
  if (decision === "approve") {
    const live = (await getSkill(proposal.skill_name)) ?? "";
    if (live !== proposal.current_content) throw new SkillChangedError(proposal.skill_name);
    await putSkill(proposal.skill_name, proposal.proposed_content);
  }
  const decided: SkillProposal = {
    ...proposal,
    status: decision === "approve" ? "APPROVED" : "REJECTED",
    decided_at: now.toISOString(),
    decided_by: actor,
  };
  await putItem(env.skillProposalsTable(), decided);
  return decided;
}

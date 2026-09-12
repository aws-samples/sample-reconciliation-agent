"use client";

import Link from "next/link";
import {
  listSkills,
  getSkill,
  saveSkill,
  createSkill,
  deleteSkill,
  type SkillType,
} from "@/lib/reconApi";
import { BTN_QUIET } from "@/components/app-ui/ui";
import { SkillsCatalog } from "@/components/app-ui/SkillsCatalog";

// The recon Skills tab: the shared catalogue in its inline mode — click a tile to view the skill in
// place, Edit ▸ to change it, Save or Delete, all on this page. No admin gate: every viewer the proxy
// admits may edit, as the routes behind it allow (docs/shared-spine-proposal.md §8a, option 1). What
// is recon's own here is the copy, the template, the `unknown` guard and the tools/model chips.

const NEW_TEMPLATE = `---
name: new-skill-name
description: One line describing when the agent uses this investigation procedure.
tools: [general-ledger___search_ledger, managed-kb___Retrieve]
model:
---
Describe the investigation procedure the agent should follow. Reference the gateway tools it
should call by their FULL prefixed names, as above — the harness backend accepts nothing else.
The knowledge-base read is managed-kb___Retrieve (Bedrock's own Retrieve operation, reached
through a managed connector); the container runtime also offers it as search_guidance. Conclude
with your reasoning and the evidence relied on. Do NOT ask the agent to rate its own certainty —
submit_proposal has no field for a self-reported number, and the platform scores the proposal by
counting which of this skill's required steps came back with data.
`;

const API = { listSkills, getSkill, createSkill, saveSkill, deleteSkill };

/** Tools the skill uses (from frontmatter), or "none" for a skill with no gateway tools, plus its model override. */
function SkillChips({ skill }: { skill: SkillType }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="rc-mono text-[10px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)]">
        Tools
      </span>
      {skill.tools && skill.tools.length > 0 ? (
        skill.tools.map((t) => (
          <span
            key={t}
            className="rc-mono rounded border border-[var(--rc-line)] px-2 py-0.5 text-[10px] text-[var(--rc-ink-dim)]"
          >
            {t}
          </span>
        ))
      ) : (
        <span className="rc-mono text-[10px] text-[var(--rc-ink-faint)]">
          none
        </span>
      )}
      {skill.model && (
        <span
          className="rc-mono rounded border border-[var(--rc-line)] px-2 py-0.5 text-[10px] text-[var(--rc-ink-faint)]"
          title="Per-skill model override"
        >
          model: {skill.model}
        </span>
      )}
    </div>
  );
}

export default function SkillsManagerPage() {
  return (
    <SkillsCatalog
      api={API}
      mode="inline"
      eyebrow="Investigation procedures · editable · applies live (~60s)"
      description={
        <>
          Each skill is a procedure the agent follows to investigate a break.
          Editing a skill&rsquo;s markdown changes how the agent reasons — the
          changes apply to new reconciliations within ~60s.
        </>
      }
      headerActions={
        <Link href="/recon/skills/system-prompt" className={BTN_QUIET}>
          Edit system prompt
        </Link>
      }
      newTemplate={NEW_TEMPLATE}
      // The fallback classification type must always exist — the page never offers to delete it, and
      // the route refuses to.
      protectedNames={["unknown"]}
      savedMessage="Saved — applies to the agent within ~60s."
      deleteWarning="The agent stops loading it within ~60s."
      tileFooter={(s) => <SkillChips skill={s} />}
    />
  );
}

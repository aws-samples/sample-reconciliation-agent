"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createSkill,
  deleteSkill,
  getSkill,
  listProposals,
  listSkills,
  saveSkill,
  type SkillSummary,
} from "@/lib/pipelineApi";
import { useAppSubject } from "@/hooks/useAppSubject";
import { BTN_QUIET, Placeholder } from "@/components/app-ui/ui";
import { SkillsCatalog } from "@/components/app-ui/SkillsCatalog";

// The universal tier of the learning loop. A skill is the rule set the parser loads on every run,
// so a change here changes how every future email is read — which is why the assistant proposes
// changes for review rather than writing them, and why this page links to those proposals first.
//
// The shared catalogue in its route mode: tiles open `skills/[name]`, where the editor lives; a
// create navigates there. Writing is admin-only, so "+ New skill" is offered to admins alone (the
// route re-checks). What is the pipeline's own here is the copy, the template, the object path under
// each tile and the pending-proposals count.

const NEW_TEMPLATE = `---
name: new-skill-name
description: One line describing when the parsing agent applies these rules.
---
Describe the parsing rules the agent should follow, in the OMS's own terms: which phrases in a
deal email map to which staging fields, the format each field takes, and any counterparty or
issuer conventions the desk relies on.

Rules here apply to EVERY deal. A rule that depends on one arranger, one sector or one source
format belongs in memory instead — save it from the Assistant tab.
`;

const API = { listSkills, getSkill, createSkill, saveSkill, deleteSkill };

export default function SkillsPage() {
  const router = useRouter();
  const { isAdmin } = useAppSubject("pipeline");
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    // Advisory count; a failure just hides the number.
    listProposals("PENDING")
      .then((p) => setPending(p.length))
      .catch(() => setPending(null));
  }, []);

  return (
    <SkillsCatalog
      api={API}
      mode="route"
      basePath="/pipeline/skills"
      onCreated={(name) =>
        router.push(`/pipeline/skills/${encodeURIComponent(name)}`)
      }
      eyebrow="Parsing rules · loaded on every run"
      description={
        <>
          Each skill is a markdown procedure the parsing agent follows. Editing
          one changes how the next email is read; the assistant&rsquo;s proposed
          edits wait here for approval.
        </>
      }
      headerActions={
        <>
          <Link href="/pipeline/skills/proposals" className={BTN_QUIET}>
            Proposals
            {pending !== null && pending > 0 && (
              <span className="ml-2 text-[var(--rc-amber)]">
                {pending} pending
              </span>
            )}
          </Link>
          <Link href="/pipeline/skills/system-prompt" className={BTN_QUIET}>
            Edit parser prompt
          </Link>
        </>
      }
      newTemplate={NEW_TEMPLATE}
      canEdit={isAdmin}
      protectedNames={[]}
      tileFooter={(s: SkillSummary) => (
        <div className="rc-mono text-[10.5px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)]">
          skills/{s.name}/SKILL.md
        </div>
      )}
      emptyState={
        <Placeholder kind="empty">
          ◇ no skills in the catalog — check PIPELINE_SKILLS_PREFIX
        </Placeholder>
      }
    />
  );
}

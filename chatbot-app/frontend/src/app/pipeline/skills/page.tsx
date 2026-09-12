"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createSkill, listProposals, listSkills, type SkillSummary } from "@/lib/pipelineApi";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import {
  BTN_CONFIRM,
  BTN_LINK,
  BTN_PRIMARY,
  BTN_QUIET,
  Eyebrow,
  INPUT_CLASS,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";

// The universal tier of the learning loop. A skill is the rule set the parser loads on every run,
// so a change here changes how every future email is read — which is why the assistant proposes
// changes for review rather than writing them, and why this page links to those proposals first.

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

export default function SkillsPage() {
  const router = useRouter();
  const { isAdmin } = usePipelineSubject();
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [content, setContent] = useState(NEW_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    listSkills()
      .then((s) => setSkills([...s].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((e) => setError(String(e)));
    // Advisory count; a failure just hides the number.
    listProposals("PENDING")
      .then((p) => setPending(p.length))
      .catch(() => setPending(null));
  }, []);

  const create = async () => {
    setBusy(true);
    setMsg(null);
    try {
      // The name comes from the frontmatter, the same place the parser reads it, so the two cannot
      // disagree.
      const m = content.match(/^name:\s*(\S+)\s*$/m);
      if (!m) throw new Error("the frontmatter must include a `name:` line");
      await createSkill(m[1], content);
      router.push(`/pipeline/skills/${encodeURIComponent(m[1])}`);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Parsing rules · loaded on every run</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            Skills
          </h1>
          <p className="mt-3 max-w-2xl text-[12.5px] leading-relaxed text-[var(--rc-ink-dim)]">
            Each skill is a markdown procedure the parsing agent follows. Editing one changes how the
            next email is read; the assistant&rsquo;s proposed edits wait here for approval.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/pipeline/skills/proposals" className={BTN_QUIET}>
            Proposals
            {pending !== null && pending > 0 && (
              <span className="ml-2 text-[var(--rc-amber)]">{pending} pending</span>
            )}
          </Link>
          <Link href="/pipeline/skills/system-prompt" className={BTN_QUIET}>
            Edit parser prompt
          </Link>
          {isAdmin && (
            <button type="button" onClick={() => setCreating((v) => !v)} className={BTN_PRIMARY}>
              + New skill
            </button>
          )}
        </div>
      </header>

      {msg && <p className="rc-mono text-[12px] text-[var(--rc-amber)]">{msg}</p>}

      {creating && (
        <Panel className="rc-rise p-5">
          <Eyebrow>New skill (SKILL.md)</Eyebrow>
          <textarea
            aria-label="New skill content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className={`${INPUT_CLASS} mt-3 h-80 w-full leading-relaxed`}
          />
          <div className="mt-3 flex gap-3">
            <button type="button" onClick={create} disabled={busy} className={BTN_CONFIRM}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button type="button" onClick={() => setCreating(false)} disabled={busy} className={BTN_LINK}>
              Cancel
            </button>
          </div>
        </Panel>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load skills — {error}</Placeholder>
      ) : !skills ? (
        <Placeholder kind="loading">◆ loading skills…</Placeholder>
      ) : skills.length === 0 ? (
        <Placeholder kind="empty">◇ no skills in the catalog — check SKILLS_PREFIX</Placeholder>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {skills.map((s, i) => (
            <Link key={s.name} href={`/pipeline/skills/${encodeURIComponent(s.name)}`} className="block">
              <Panel className="rc-rise flex h-full flex-col p-5 hover:border-[var(--rc-cyan)]" title={`Open ${s.name}`}>
                <div style={{ animationDelay: `${i * 50}ms` }} className="flex h-full flex-col">
                  <div className="flex items-start gap-2">
                    <span className="mt-[6px] text-[var(--rc-cyan)]">▸</span>
                    <span className="rc-mono text-[14px] font-medium text-[var(--rc-cyan)]">{s.name}</span>
                  </div>
                  <p className="mt-3 flex-1 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                    {s.description || "no description in the frontmatter"}
                  </p>
                  <div className="rc-mono mt-5 border-t border-[var(--rc-line-soft)] pt-3 text-[10.5px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)]">
                    skills/{s.name}/SKILL.md
                  </div>
                </div>
              </Panel>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

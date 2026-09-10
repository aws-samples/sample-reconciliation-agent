"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listSkills,
  getSkill,
  saveSkill,
  createSkill,
  deleteSkill,
  type SkillType,
} from "@/lib/reconApi";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";

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

export default function SkillsManagerPage() {
  const [skills, setSkills] = useState<SkillType[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // skill name or "__new__"
  const [viewing, setViewing] = useState<string | null>(null); // read-only skill name
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    listSkills()
      .then(setSkills)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    load();
  }, []);

  // Clicking a skill tile opens it READ-ONLY (view). Editing is an explicit action.
  const openView = async (name: string) => {
    setMsg(null);
    setEditing(null);
    setViewing(name);
    setContent("… loading …");
    try {
      setContent((await getSkill(name)).content);
    } catch (e) {
      setContent("");
      setMsg(String(e));
    }
  };

  const openSkill = async (name: string) => {
    setMsg(null);
    setViewing(null);
    setEditing(name);
    setContent("… loading …");
    try {
      setContent((await getSkill(name)).content);
    } catch (e) {
      setContent("");
      setMsg(String(e));
    }
  };

  const openNew = () => {
    setMsg(null);
    setViewing(null);
    setEditing("__new__");
    setContent(NEW_TEMPLATE);
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (editing === "__new__") {
        const m = content.match(/name:\s*(\S+)/);
        if (!m) throw new Error("frontmatter must include a name");
        await createSkill(m[1], content);
      } else if (editing) {
        await saveSkill(editing, content);
      }
      setMsg("Saved — applies to the agent within ~60s.");
      setEditing(null);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    if (!confirm(`Delete skill "${name}"?`)) return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteSkill(name);
      await load();
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        {/* min-w-0 + flex-1 lets this column consume the leftover header width so
            the description wraps at the viewport edge instead of a fixed max-width.
            basis-[320px] makes it drop to its own row before it gets too narrow. */}
        <div className="min-w-0 flex-1 basis-[320px]">
          <Eyebrow>
            Investigation procedures · editable · applies live (~60s)
          </Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            Skills
          </h1>
          <p className="rc-mono mt-3 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
            Each skill is a procedure the agent follows to investigate a break.
            Editing a skill&rsquo;s markdown changes how the agent reasons — the
            changes apply to new reconciliations within ~60s.
          </p>
        </div>
        <div className="flex shrink-0 gap-3">
          <Link
            href="/recon/skills/system-prompt"
            className="rc-mono rounded border border-[var(--rc-line)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)]"
          >
            Edit system prompt
          </Link>
          <button
            onClick={openNew}
            className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04120f]"
          >
            + New skill
          </button>
        </div>
      </header>

      {msg && (
        <p className="rc-mono text-[12px] text-[var(--rc-cyan)]">{msg}</p>
      )}

      {editing !== null && (
        <Panel className="rc-rise p-5">
          <Eyebrow>
            {editing === "__new__"
              ? "New skill (SKILL.md)"
              : `Editing ${editing}`}
          </Eyebrow>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className="rc-mono mt-3 h-80 w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 text-[12px] leading-relaxed text-[var(--rc-ink)]"
          />
          <div className="mt-3 flex gap-3">
            <button
              onClick={save}
              disabled={busy}
              className="rc-mono rounded border border-[var(--rc-green)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              onClick={() => setEditing(null)}
              disabled={busy}
              className="rc-mono px-3 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
            >
              Cancel
            </button>
          </div>
        </Panel>
      )}

      {viewing !== null && (
        <Panel className="rc-rise p-5">
          <div className="flex items-center justify-between">
            <Eyebrow>Viewing {viewing} · read-only</Eyebrow>
            <div className="flex gap-3">
              <button
                onClick={() => openSkill(viewing)}
                className="rc-mono rounded border border-[var(--rc-cyan)] px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#04120f]"
              >
                Edit ▸
              </button>
              <button
                onClick={() => setViewing(null)}
                className="rc-mono px-3 py-1.5 text-[11px] uppercase tracking-[0.12em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
              >
                Close
              </button>
            </div>
          </div>
          <pre className="rc-mono mt-3 max-h-96 overflow-auto whitespace-pre-wrap rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 text-[12px] leading-relaxed text-[var(--rc-ink)]">
            {content}
          </pre>
        </Panel>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load skills — {error}</Placeholder>
      ) : !skills ? (
        <Placeholder kind="loading">◆ loading skills…</Placeholder>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {skills.map((s, i) => (
            <Panel
              key={s.name}
              className="rc-rise flex cursor-pointer flex-col p-5 hover:border-[var(--rc-cyan)]"
              onClick={() => openView(s.name)}
              title={`View ${s.name} (read-only)`}
            >
              <div
                style={{ animationDelay: `${i * 50}ms` }}
                className="flex h-full flex-col"
              >
                <div className="flex items-start gap-2">
                  <span className="mt-[6px] text-[var(--rc-cyan)]">▸</span>
                  <span className="rc-mono text-[14px] font-medium text-[var(--rc-cyan)]">
                    {s.name}
                  </span>
                </div>
                <p className="mt-3 flex-1 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                  {s.description}
                </p>
                <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
                  {/* Tools the skill uses (from frontmatter). Empty = no gateway tools. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rc-mono text-[10px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)]">
                      Tools
                    </span>
                    {s.tools && s.tools.length > 0 ? (
                      s.tools.map((t) => (
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
                    {s.model && (
                      <span
                        className="rc-mono rounded border border-[var(--rc-line)] px-2 py-0.5 text-[10px] text-[var(--rc-ink-faint)]"
                        title="Per-skill model override"
                      >
                        model: {s.model}
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex gap-4">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openSkill(s.name);
                      }}
                      className="rc-mono text-[11px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:opacity-80"
                    >
                      Edit ▸
                    </button>
                    {s.name !== "unknown" && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(s.name);
                        }}
                        className="rc-mono text-[11px] uppercase tracking-[0.1em] text-[var(--rc-red)] hover:opacity-80"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}

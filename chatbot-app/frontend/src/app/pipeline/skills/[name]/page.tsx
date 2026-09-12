"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteSkill, getSkill, saveSkill } from "@/lib/pipelineApi";
import { useAppSubject } from "@/hooks/useAppSubject";
import {
  BTN_CONFIRM,
  BTN_DANGER,
  BTN_LINK,
  Eyebrow,
  INPUT_CLASS,
  Modal,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "@/components/app-ui/ui";

export default function SkillEditorPage({ params }: { params: Promise<{ name: string }> }) {
  const { name: rawName } = use(params);
  // The segment can arrive decoded or still percent-encoded depending on how it was linked; decode
  // once, and keep the raw value if it is not valid percent-encoding rather than throwing.
  const name = useMemo(() => {
    try {
      return decodeURIComponent(rawName);
    } catch {
      return rawName;
    }
  }, [rawName]);
  const router = useRouter();
  const { isAdmin } = useAppSubject("pipeline");
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Carries its tone: a refused S3 write must not read like "Saved".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    getSkill(name)
      .then((s) => {
        setContent(s.content);
        setSaved(s.content);
      })
      .catch((e) => setError(String(e)));
  }, [name]);

  const dirty = content !== null && content !== saved;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await saveSkill(name, content ?? "");
      setSaved(content);
      setMsg({
        tone: "success",
        text: "Saved — the parser loads skills from S3 on every run, so the next email uses this text.",
      });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await deleteSkill(name);
      router.push("/pipeline/skills");
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/pipeline/skills"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Skills
        </Link>
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">skills/{name}/SKILL.md</span>
      </div>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>{isAdmin ? "Skill · editable · applies on the next run" : "Skill · read-only"}</Eyebrow>
          <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
            {name}
          </h1>
        </div>
        {isAdmin && (
          <div className="flex gap-3">
            <button type="button" onClick={save} disabled={busy || !dirty} className={BTN_CONFIRM}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setConfirming(true)} disabled={busy} className={BTN_DANGER}>
              Delete
            </button>
          </div>
        )}
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!isAdmin && (
        <p className="rc-mono text-[11.5px] text-[var(--rc-ink-faint)]">
          Editing requires membership of the admin group. Propose a change through the Assistant
          instead; it lands on the proposals page for review.
        </p>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : content === null ? (
        <Placeholder kind="loading">◆ loading {name}…</Placeholder>
      ) : (
        <Panel className="rc-rise p-5">
          <textarea
            aria-label="Skill content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={!isAdmin}
            spellCheck={false}
            className={`${INPUT_CLASS} h-[60vh] min-h-[320px] w-full text-[12.5px] leading-relaxed`}
          />
        </Panel>
      )}

      {confirming && (
        <Modal
          title={`Delete skill "${name}"?`}
          subtitle="The parser stops loading it on its next run. Proposals that reference it stay in their history."
          onClose={() => setConfirming(false)}
          className="max-w-xl"
        >
          <div className="flex items-center gap-3">
            <button type="button" onClick={remove} disabled={busy} className={BTN_DANGER}>
              {busy ? "Deleting…" : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirming(false)} disabled={busy} className={BTN_LINK}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

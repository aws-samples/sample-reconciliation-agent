"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { deleteSkill, getSkill, saveSkill } from "@/lib/pipelineApi";
import { useAppSubject } from "@/hooks/useAppSubject";
import {
  Eyebrow,
  Notice,
  Placeholder,
  type ActionOutcome,
} from "@/components/app-ui/ui";
import { SkillEditor } from "@/components/app-ui/SkillEditor";

// One skill, on its own route: the shared editor under a header that names it. Admins edit and
// delete; everyone else reads. Save is withheld until something changed, so a page left open cannot
// rewrite a skill with itself.
export default function SkillEditorPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
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
  /** The content as loaded or last saved — the editor's baseline. */
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Carries its tone: a refused S3 write must not read like "Saved".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);

  useEffect(() => {
    getSkill(name)
      .then((s) => setSaved(s.content))
      .catch((e) => setError(String(e)));
  }, [name]);

  const save = async (draft: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await saveSkill(name, draft);
      setSaved(draft);
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
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          skills/{name}/SKILL.md
        </span>
      </div>
      <header>
        <Eyebrow>
          {isAdmin
            ? "Skill · editable · applies on the next run"
            : "Skill · read-only"}
        </Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          {name}
        </h1>
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {!isAdmin && (
        <p className="rc-mono text-[11.5px] text-[var(--rc-ink-faint)]">
          Editing requires membership of the admin group. Propose a change
          through the Assistant instead; it lands on the proposals page for
          review.
        </p>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : (
        <SkillEditor
          name={name}
          content={saved}
          readOnly={!isAdmin}
          busy={busy}
          disableSaveWhenClean
          eyebrow={null}
          onSave={save}
          onDelete={isAdmin ? remove : undefined}
          deleteWarning="The parser stops loading it on its next run. Proposals that reference it stay in their history."
          heightClass="h-[60vh] min-h-[320px]"
        />
      )}
    </div>
  );
}

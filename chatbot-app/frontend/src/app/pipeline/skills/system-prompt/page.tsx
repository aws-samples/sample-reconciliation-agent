"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getParserPrompt, saveParserPrompt } from "@/lib/pipelineApi";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import {
  BTN_CONFIRM,
  Eyebrow,
  INPUT_CLASS,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "@/components/app-ui/ui";

// The parsing agent's system prompt: how it approaches an email before any skill is applied. Stored
// in S3 and read on every run, so an edit applies without a redeploy.
export default function ParserPromptPage() {
  const { isAdmin } = usePipelineSubject();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Carries its tone: a refused S3 write must not read like "Saved".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);

  useEffect(() => {
    getParserPrompt()
      .then((r) => {
        setContent(r.content);
        setSaved(r.content);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await saveParserPrompt(content ?? "");
      setSaved(content);
      setMsg({ tone: "success", text: "Saved — the next parse uses this prompt." });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
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
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">prompts/parser-system.md</span>
      </div>
      <header>
        <Eyebrow>{isAdmin ? "Parsing agent · system prompt · applies on the next run" : "Parsing agent · system prompt · read-only"}</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Parser prompt
        </h1>
      </header>

      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : content === null ? (
        <Placeholder kind="loading">◆ loading the parser prompt…</Placeholder>
      ) : (
        <Panel className="rc-rise p-5">
          <textarea
            aria-label="Parser system prompt"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            readOnly={!isAdmin}
            spellCheck={false}
            placeholder="Describe how the parsing agent should read a deal email…"
            className={`${INPUT_CLASS} h-[60vh] min-h-[320px] w-full text-[13px] leading-relaxed`}
          />
          {isAdmin && (
            <button
              type="button"
              onClick={save}
              disabled={busy || content === saved}
              className={`${BTN_CONFIRM} mt-3`}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          )}
        </Panel>
      )}
    </div>
  );
}

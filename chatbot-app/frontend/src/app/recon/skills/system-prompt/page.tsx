"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSystemPrompt, saveSystemPrompt } from "@/lib/reconApi";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";

// System-prompt editor: defines the overall reconciliation workflow the agent follows. Stored in
// S3, read live by the agent (~60s), so edits apply without a redeploy.
//
// This is the SHARED policy core — both Tier-2 backends read this one object (the harness appends
// its own calling contract on top). Saying so in the UI matters: the previous split-per-backend
// layout let an edit here apply to whichever backend happened to be active and silently not the
// other.
export default function SystemPromptPage() {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getSystemPrompt()
      .then((r) => setContent(r.content))
      .catch((e) => setError(String(e)));
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await saveSystemPrompt(content ?? "");
      setMsg("Saved — applies to both Tier-2 backends within ~60s.");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/recon/skills"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Skills
        </Link>
      </div>
      <header>
        <Eyebrow>
          Overall workflow · shared by both Tier-2 backends · applies live
          (~60s)
        </Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          System Prompt
        </h1>
      </header>

      {msg && (
        <p className="rc-mono text-[12px] text-[var(--rc-cyan)]">{msg}</p>
      )}

      {error ? (
        <Placeholder kind="error">Failed to load — {error}</Placeholder>
      ) : content === null ? (
        <Placeholder kind="loading">◆ loading system prompt…</Placeholder>
      ) : (
        <Panel className="rc-rise p-5">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder="Define the overall reconciliation workflow the agent should follow…"
            className="rc-mono h-96 w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 text-[13px] leading-relaxed text-[var(--rc-ink)]"
          />
          <button
            onClick={save}
            disabled={busy}
            className="rc-mono mt-3 rounded border border-[var(--rc-green)] px-5 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </Panel>
      )}
    </div>
  );
}

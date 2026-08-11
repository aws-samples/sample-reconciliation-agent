"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  listLessons,
  getMemoryRecords,
  type Lesson,
  type MemoryRecord,
} from "@/lib/reconApi";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";

const TRIGGER_COLOR: Record<string, string> = {
  USER_CORRECTION: "var(--rc-amber)",
  USER_APPROVED: "var(--rc-green)",
};

// Lessons-learned tab: how users decided to proceed, captured from the approve/disapprove flow
// and fed back to the agent's future proposals.
export default function LessonsPage() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRecord[] | null>(null);

  useEffect(() => {
    listLessons()
      .then((l) =>
        setLessons(
          [...l].sort((a, b) =>
            (b.created_at ?? "").localeCompare(a.created_at ?? ""),
          ),
        ),
      )
      .catch((e) => setError(String(e)));

    // Long-term memory is advisory context — a failure here shows an empty state rather
    // than blocking the decisions table above.
    getMemoryRecords()
      .then((m) =>
        setMemory(
          [...m].sort((a, b) =>
            (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
          ),
        ),
      )
      .catch(() => setMemory([]));
  }, []);

  return (
    <div className="space-y-6">
      <header>
        <Eyebrow>Captured from analyst decisions</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Lessons Learned
        </h1>
        <p className="rc-mono mt-3 max-w-2xl text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
          When an analyst approves or corrects a recommendation, the decision is
          captured here and fed back into the agent&rsquo;s memory to inform
          future reconciliations.
        </p>
      </header>

      {error ? (
        <Placeholder kind="error">Failed to load lessons — {error}</Placeholder>
      ) : !lessons ? (
        <Placeholder kind="loading">◆ loading lessons…</Placeholder>
      ) : lessons.length === 0 ? (
        <Placeholder kind="empty">◇ no lessons captured yet</Placeholder>
      ) : (
        <Panel className="rc-rise overflow-hidden">
          <div className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_2fr] gap-4 border-b border-[var(--rc-line)] px-5 py-3">
            {["Case", "Domain", "Class", "Decision", "Comment"].map((h) => (
              <div key={h} className="rc-eyebrow">
                {h}
              </div>
            ))}
          </div>
          {lessons.map((l) => (
            <div
              key={l.lesson_id}
              className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_2fr] items-center gap-4 border-b border-[var(--rc-line-soft)] px-5 py-4 last:border-0"
            >
              <Link
                href={`/recon/case/${encodeURIComponent(l.item_id)}`}
                className="rc-mono text-[13px] text-[var(--rc-cyan)]"
              >
                {l.item_id}
              </Link>
              <div className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
                {l.domain}
              </div>
              <div className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
                {l.class_id}
              </div>
              <div
                className="rc-mono text-[11px] uppercase"
                style={{
                  color: TRIGGER_COLOR[l.trigger] ?? "var(--rc-ink-dim)",
                }}
              >
                {l.disposition ?? l.trigger.replace("USER_", "").toLowerCase()}
              </div>
              <div className="text-[13px] text-[var(--rc-ink)]">
                {l.user_comment ?? "—"}
              </div>
            </div>
          ))}
        </Panel>
      )}

      <section className="space-y-4">
        <header>
          <Eyebrow>Retrieved live from AgentCore Memory</Eyebrow>
          <h2 className="rc-display mt-2 text-[24px] font-black leading-none text-[var(--rc-ink)]">
            Agent Long-Term Memory
          </h2>
          <p className="rc-mono mt-2 max-w-2xl text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
            Consolidated lessons the agent recalls before classifying —
            retrieved live from AgentCore Memory.
          </p>
        </header>

        {!memory ? (
          <Placeholder kind="loading">◆ loading memory…</Placeholder>
        ) : memory.length === 0 ? (
          <Placeholder kind="empty">
            No consolidated memory yet — or RECON_MEMORY_ID not configured.
          </Placeholder>
        ) : (
          <Panel className="rc-rise overflow-hidden">
            <div className="grid grid-cols-[0.8fr_3fr_0.8fr] gap-4 border-b border-[var(--rc-line)] px-5 py-3">
              {["Domain", "Memory", "Captured"].map((h) => (
                <div key={h} className="rc-eyebrow">
                  {h}
                </div>
              ))}
            </div>
            {memory.map((m) => (
              <div
                key={m.id}
                className="grid grid-cols-[0.8fr_3fr_0.8fr] items-center gap-4 border-b border-[var(--rc-line-soft)] px-5 py-4 last:border-0"
              >
                <div className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
                  {m.domain}
                </div>
                <div className="text-[13px] text-[var(--rc-ink)]">
                  {m.content}
                </div>
                <div className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
                  {m.createdAt ? m.createdAt.slice(0, 10) : "—"}
                </div>
              </div>
            ))}
          </Panel>
        )}
      </section>
    </div>
  );
}

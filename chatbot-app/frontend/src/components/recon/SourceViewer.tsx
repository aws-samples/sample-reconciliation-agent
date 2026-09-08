"use client";

import { Disclosure, Eyebrow, Placeholder } from "@/components/recon/ui";
import type { LambdaSourceFile } from "@/lib/reconApi";

// Read-only source viewer used by the Config tab for each of the three code surfaces it publishes
// (Tier-1 Lambda, Tier-2 container agent, egress-gateway interceptor). Extracted because the three
// sections are identical apart from their labels and their loading state, and a third hand-copied
// block would have been a third place to fix any viewer bug.
//
// Every file is one collapsed row, opened on click. This replaced a tab strip over an always-open
// scrolling pane, which put several hundred lines of code between the top of the page and whatever an
// operator had actually come to the Config tab to change. The code is published so the guarantees in
// the prose above each section are auditable — which is a thing to go and read deliberately, not a
// thing to have to scroll past three times.

/** How many lines a file has, for the row's right-hand hint — enough to judge before opening it. */
function lineCount(content: string): number {
  return content ? content.split("\n").length : 0;
}

export function SourceViewer({
  title,
  files,
  error,
  noun,
}: {
  /** Eyebrow heading, e.g. "Tier-1 Lambda source · read-only". */
  title: string;
  /** The loaded files; `null` means still loading (an empty array means "none published"). */
  files: LambdaSourceFile[] | null;
  /** Load failure message, or `null`/`undefined` when the load has not failed. */
  error?: string | null;
  /** What to call the code in the loading/empty/error text, e.g. "agent source". */
  noun: string;
}) {
  return (
    <div className="mt-6 border-t border-[var(--rc-line)] pt-5">
      <Eyebrow>{title}</Eyebrow>
      <div className="mt-3">
        {error ? (
          <Placeholder kind="error">
            Failed to load {noun} — {error}
          </Placeholder>
        ) : !files ? (
          <Placeholder kind="loading">◆ loading {noun}…</Placeholder>
        ) : files.length === 0 ? (
          <Placeholder kind="empty">◇ no {noun} published</Placeholder>
        ) : (
          <div className="space-y-2">
            {files.map((f) => (
              <Disclosure
                key={f.path}
                summary={
                  <span className="rc-mono text-[12px] tracking-[0.06em] text-[var(--rc-ink)]">
                    {f.path}
                  </span>
                }
                meta={`${lineCount(f.content)} lines`}
              >
                <pre className="max-h-[520px] overflow-auto bg-[var(--rc-panel-2)] p-4 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                  <code className="rc-mono">{f.content}</code>
                </pre>
              </Disclosure>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

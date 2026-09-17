"use client";

import { useMemo } from "react";
import { diffLines, diffStats } from "@/components/pipeline/textDiff";

/**
 * The line diff between a skill's current content and a proposed replacement.
 *
 * Unified rather than side-by-side: the drawer it sits in is a third of the viewport wide, and two
 * columns of markdown at that width wrap every line into unreadability.
 */
export function LineDiff({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  const stats = useMemo(() => diffStats(diff), [diff]);

  if (stats.added === 0 && stats.removed === 0)
    return (
      <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
        ◇ the proposed content is identical to the current skill
      </p>
    );

  return (
    <div className="overflow-hidden rounded border border-[var(--rc-line)]">
      <div className="rc-mono flex gap-4 border-b border-[var(--rc-line)] bg-[var(--rc-line-soft)]/40 px-3 py-1.5 text-[11px]">
        <span style={{ color: "var(--rc-green)" }}>+{stats.added}</span>
        <span style={{ color: "var(--rc-red)" }}>−{stats.removed}</span>
        <span className="text-[var(--rc-ink-faint)]">{diff.length} lines</span>
      </div>
      <pre className="rc-mono max-h-[520px] overflow-auto py-2 text-[12px] leading-relaxed">
        {diff.map((line, i) => (
          <div key={i} className={`rc-diff-line ${line.kind}`} data-kind={line.kind}>
            <span aria-hidden className="select-none text-right">
              {line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "}
            </span>
            <span>{line.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

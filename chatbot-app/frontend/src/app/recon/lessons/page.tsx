"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  listLessons,
  getMemoryRecords,
  deleteMemoryRecords,
  getMemoryStrategy,
  type Lesson,
  type MemoryRecord,
} from "@/lib/reconApi";
import {
  DEFAULT_LESSON_FILTER,
  filterLessons,
  lessonFilterCounts,
  lessonFilterOptions,
  type LessonFilter,
} from "@/lib/lessonFilter";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";
import {
  MEMORY_PANEL_DEFAULT_COLUMNS,
  MemoryPanel,
  type MemoryPanelColumn,
} from "@/components/app-ui/MemoryPanel";

const TRIGGER_COLOR: Record<string, string> = {
  USER_CORRECTION: "var(--rc-amber)",
  USER_APPROVED: "var(--rc-green)",
};

const INPUT_CLASS =
  "rc-mono rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-1.5 text-[12px] text-[var(--rc-ink)]";

// The memory table's columns: the domain each record was recalled for — the one column the shared
// panel's defaults do not have, because only recon's records carry it — then the shared memory text
// and capture-date columns.
const MEMORY_COLUMNS: MemoryPanelColumn<MemoryRecord>[] = [
  {
    key: "domain",
    header: "Domain",
    width: "0.8fr",
    className: "rc-mono text-[12px] text-[var(--rc-ink-dim)]",
    render: (m) => m.domain,
  },
  ...MEMORY_PANEL_DEFAULT_COLUMNS,
];

// Lessons-learned tab: how users decided to proceed, captured from the approve/disapprove flow
// and fed back to the agent's future proposals.
export default function LessonsPage() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opens comment-only: most rows come from bulk triage with nothing typed, and a table of dashes
  // hides the handful of rows that actually explain a decision. The count line below says what was
  // hidden, and "show all" is one click away — a filtering default must not read as missing data.
  const [filter, setFilter] = useState<LessonFilter>(DEFAULT_LESSON_FILTER);

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
  }, []);

  const shown = useMemo(
    () => (lessons ? filterLessons({ lessons, filter }) : []),
    [lessons, filter],
  );
  const counts = useMemo(
    () =>
      lessons
        ? lessonFilterCounts({ lessons, filter })
        : { total: 0, shown: 0, hiddenNoComment: 0 },
    [lessons, filter],
  );
  const options = useMemo(
    () =>
      lessons ? lessonFilterOptions(lessons) : { domains: [], decisions: [] },
    [lessons],
  );
  const isFiltered =
    filter.commentOnly ||
    filter.query.trim() !== "" ||
    filter.domain !== "" ||
    filter.decision !== "";

  return (
    <div className="space-y-6">
      <header>
        <Eyebrow>Captured from analyst decisions</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Lessons Learned
        </h1>
        <p className="rc-mono mt-3 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
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
        <>
          {/* Filter bar: free text + domain + decision + the comment-only default. */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              placeholder="Search case / class / comment…"
              className={`${INPUT_CLASS} min-w-[240px]`}
            />
            <select
              value={filter.domain}
              onChange={(e) => setFilter({ ...filter, domain: e.target.value })}
              aria-label="Filter by domain"
              className={INPUT_CLASS}
            >
              <option value="">all domains</option>
              {options.domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={filter.decision}
              onChange={(e) =>
                setFilter({ ...filter, decision: e.target.value })
              }
              aria-label="Filter by decision"
              className={INPUT_CLASS}
            >
              <option value="">all decisions</option>
              {options.decisions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <label className="rc-mono flex items-center gap-2 text-[12px] text-[var(--rc-ink-dim)]">
              <input
                type="checkbox"
                checked={filter.commentOnly}
                onChange={(e) =>
                  setFilter({ ...filter, commentOnly: e.target.checked })
                }
                className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
              />
              with a comment only
            </label>
            {isFiltered && (
              <button
                onClick={() =>
                  setFilter({
                    commentOnly: false,
                    query: "",
                    domain: "",
                    decision: "",
                  })
                }
                className="rc-mono px-2 py-1 text-[11px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
              >
                Show all
              </button>
            )}
          </div>

          {/* What the filter removed, said out loud — a default that hides rows must not read as
              missing data. */}
          <p className="rc-mono rc-tnum text-[11px] text-[var(--rc-ink-faint)]">
            Showing {counts.shown} of {counts.total}
            {filter.commentOnly && counts.hiddenNoComment > 0
              ? ` — ${counts.hiddenNoComment} without a comment hidden`
              : ""}
          </p>

          {shown.length === 0 ? (
            <Placeholder kind="empty">
              ◇ no lessons match this filter
            </Placeholder>
          ) : (
            <Panel className="rc-rise overflow-hidden">
              <div className="grid grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr_2fr] gap-4 border-b border-[var(--rc-line)] px-5 py-3">
                {["Case", "Domain", "Class", "Decision", "Comment"].map((h) => (
                  <div key={h} className="rc-eyebrow">
                    {h}
                  </div>
                ))}
              </div>
              {shown.map((l) => (
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
                    {l.disposition ??
                      l.trigger.replace("USER_", "").toLowerCase()}
                  </div>
                  <div className="text-[13px] text-[var(--rc-ink)]">
                    {l.user_comment ?? "—"}
                  </div>
                </div>
              ))}
            </Panel>
          )}
        </>
      )}

      {/* The agent's consolidated long-term memory — the shared panel over recon's memory routes.
          Long-term memory is advisory context: the panel degrades to an empty state on a failure
          rather than taking the decisions table above with it. */}
      <MemoryPanel
        listRecords={getMemoryRecords}
        deleteRecords={deleteMemoryRecords}
        getStrategy={getMemoryStrategy}
        columns={MEMORY_COLUMNS}
        memoryIdEnvName="RECON_MEMORY_ID"
        header={
          <header>
            <Eyebrow>Retrieved live from AgentCore Memory</Eyebrow>
            <h2 className="rc-display mt-2 text-[24px] font-black leading-none text-[var(--rc-ink)]">
              Agent Long-Term Memory
            </h2>
            <p className="rc-mono mt-2 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
              Consolidated lessons the agent recalls before classifying —
              retrieved live from AgentCore Memory.
            </p>
          </header>
        }
        deleteWarning="The agent will no longer recall them when classifying. This cannot be undone — the DynamoDB lessons ledger above keeps the underlying analyst decisions, but the consolidated memory is regenerated only from future decisions."
      />
    </div>
  );
}

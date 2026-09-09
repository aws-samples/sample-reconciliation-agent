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
  type MemoryStrategyInfo,
  type MemoryStrategyResponse,
} from "@/lib/reconApi";
import {
  DEFAULT_LESSON_FILTER,
  filterLessons,
  lessonFilterCounts,
  lessonFilterOptions,
  type LessonFilter,
} from "@/lib/lessonFilter";
import {
  Disclosure,
  Eyebrow,
  Modal,
  Panel,
  Placeholder,
} from "@/components/recon/ui";

const TRIGGER_COLOR: Record<string, string> = {
  USER_CORRECTION: "var(--rc-amber)",
  USER_APPROVED: "var(--rc-green)",
};

const INPUT_CLASS =
  "rc-mono rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-1.5 text-[12px] text-[var(--rc-ink)]";

const STRATEGY_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "var(--rc-green)",
  CREATING: "var(--rc-cyan)",
  DELETING: "var(--rc-amber)",
  FAILED: "var(--rc-red)",
};

/**
 * One row of key/value metadata inside an expanded strategy.
 *
 * @param label the field name.
 * @param value the field value, already stringified by the caller.
 */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="rc-eyebrow">{label}</div>
      <div className="rc-mono mt-1 break-all text-[12px] text-[var(--rc-ink)]">
        {value}
      </div>
    </div>
  );
}

/**
 * One strategy as a collapsed disclosure: identity and status on the row, the prompt inside.
 *
 * Read-only throughout. The strategy is owned by Terraform, and changing its `type` replaces it —
 * which deletes every record in the table below — so this surface reports and never edits.
 *
 * @param strategy the flattened strategy projection from `GET /api/recon/memory/strategy`.
 */
function StrategyCard({ strategy }: { strategy: MemoryStrategyInfo }) {
  // Only the phases that actually carry an override. A built-in strategy has neither, and saying
  // "built-in prompt" is more honest than rendering two empty boxes.
  const phases = [
    { label: "Extraction prompt", override: strategy.extraction },
    { label: "Consolidation prompt", override: strategy.consolidation },
  ].filter((p) => p.override !== null);

  return (
    <Disclosure
      summary={
        <span className="rc-mono flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
          <span className="text-[var(--rc-ink)]">{strategy.name}</span>
          <span className="text-[var(--rc-ink-faint)]">
            {strategy.configurationType
              ? `${strategy.type} · ${strategy.configurationType}`
              : strategy.type}
          </span>
          <span
            className="text-[11px] uppercase tracking-[0.1em]"
            style={{
              color:
                STRATEGY_STATUS_COLOR[strategy.status] ?? "var(--rc-ink-dim)",
            }}
          >
            {strategy.status}
          </span>
        </span>
      }
      meta={phases.length === 0 ? "built-in prompt" : "read-only"}
    >
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Namespaces" value={strategy.namespaces.join(", ")} />
          <Field
            label="Extraction model"
            value={strategy.extraction?.modelId ?? "—"}
          />
        </div>

        {strategy.description && (
          <Field label="Description" value={strategy.description} />
        )}

        {phases.length === 0 ? (
          <Placeholder kind="empty">
            No prompt override — this strategy runs AgentCore&rsquo;s built-in
            instructions, which the service does not expose.
          </Placeholder>
        ) : (
          phases.map((p) => (
            <div key={p.label}>
              <Eyebrow>
                {p.label} · {p.override!.kind}
              </Eyebrow>
              <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap rounded bg-[var(--rc-panel-2)] p-4 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                <code className="rc-mono">{p.override!.appendToPrompt}</code>
              </pre>
            </div>
          ))
        )}
      </div>
    </Disclosure>
  );
}

// Lessons-learned tab: how users decided to proceed, captured from the approve/disapprove flow
// and fed back to the agent's future proposals.
export default function LessonsPage() {
  const [lessons, setLessons] = useState<Lesson[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<MemoryRecord[] | null>(null);
  // Opens comment-only: most rows come from bulk triage with nothing typed, and a table of dashes
  // hides the handful of rows that actually explain a decision. The count line below says what was
  // hidden, and "show all" is one click away — a filtering default must not read as missing data.
  const [filter, setFilter] = useState<LessonFilter>(DEFAULT_LESSON_FILTER);
  // Memory-record selection lives here rather than in the row, so the action bar can name a count.
  const [selectedMemory, setSelectedMemory] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Delete failures only. A retrieve failure still degrades to an empty panel below, because advisory
  // context must not take the decisions table with it.
  const [memoryError, setMemoryError] = useState<string | null>(null);
  // The live extraction strategy behind the records. Read-only — see the panel below.
  const [strategy, setStrategy] = useState<MemoryStrategyResponse | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);

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

    // Explanatory context for the records above it. Fetched independently so a missing GetMemory
    // grant surfaces as a note on this one panel instead of emptying the memory table.
    getMemoryStrategy()
      .then(setStrategy)
      .catch((e) => setStrategyError(String(e)));
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

  /** Add or remove one memory record from the selection. */
  function toggleMemory(id: string): void {
    setSelectedMemory((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select every loaded record, or clear the selection when all of them are already selected. */
  function toggleAllMemory(): void {
    setSelectedMemory((prev) =>
      prev.size === (memory?.length ?? 0)
        ? new Set()
        : new Set((memory ?? []).map((m) => m.id)),
    );
  }

  /**
   * Delete the selected records, then drop them from the panel.
   *
   * Only the ids the service confirms are removed locally. A record the service refused stays on
   * screen with its reason shown — hiding it would tell the operator it is gone when the agent will
   * still recall it.
   */
  async function deleteSelectedMemory(): Promise<void> {
    setDeleting(true);
    setMemoryError(null);
    try {
      const result = await deleteMemoryRecords([...selectedMemory]);
      const gone = new Set(result.deleted);
      setMemory((prev) => (prev ?? []).filter((m) => !gone.has(m.id)));
      setSelectedMemory(
        new Set([...selectedMemory].filter((id) => !gone.has(id))),
      );
      if (result.failed.length > 0) {
        setMemoryError(
          result.failed.map((f) => `${f.id}: ${f.error}`).join("; "),
        );
      }
      setConfirmDelete(false);
    } catch (e) {
      setMemoryError(String(e));
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  }

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

        {/* What produced the records below: the live strategy and the prompt that decides what
            counts as a lesson. Read from the memory itself rather than restated from Terraform, so
            it cannot drift from what is actually running. */}
        {strategyError ? (
          <Placeholder kind="error">
            Could not read the memory strategy — {strategyError}
          </Placeholder>
        ) : strategy && !strategy.configured ? (
          <Placeholder kind="empty">
            RECON_MEMORY_ID not configured — no strategy to show.
          </Placeholder>
        ) : strategy && strategy.strategies.length > 0 ? (
          <div className="space-y-2">
            <Eyebrow>
              Extraction strategy · read-only
              {strategy.memoryStatus
                ? ` · memory ${strategy.memoryStatus}`
                : ""}
            </Eyebrow>
            {strategy.strategies.map((s) => (
              <StrategyCard key={s.id} strategy={s} />
            ))}
          </div>
        ) : null}

        {memoryError && (
          <Placeholder kind="error">Delete failed — {memoryError}</Placeholder>
        )}

        {!memory ? (
          <Placeholder kind="loading">◆ loading memory…</Placeholder>
        ) : memory.length === 0 ? (
          <Placeholder kind="empty">
            No consolidated memory yet — or RECON_MEMORY_ID not configured.
          </Placeholder>
        ) : (
          <>
            {selectedMemory.size > 0 && (
              <Panel className="rc-rise flex flex-wrap items-center gap-3 p-4">
                <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
                  {selectedMemory.size} selected
                </span>
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="rc-mono rounded border border-[var(--rc-amber)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-amber)] hover:bg-[var(--rc-amber)] hover:text-[#140a00]"
                >
                  Delete selected
                </button>
                <button
                  onClick={() => setSelectedMemory(new Set())}
                  className="rc-mono px-2 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
                >
                  Clear
                </button>
              </Panel>
            )}

            <Panel className="rc-rise overflow-hidden">
              <div className="grid grid-cols-[auto_0.8fr_3fr_0.8fr] gap-4 border-b border-[var(--rc-line)] px-5 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all memory records"
                  checked={
                    selectedMemory.size > 0 &&
                    selectedMemory.size === memory.length
                  }
                  onChange={toggleAllMemory}
                  className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                />
                {["Domain", "Memory", "Captured"].map((h) => (
                  <div key={h} className="rc-eyebrow">
                    {h}
                  </div>
                ))}
              </div>
              {memory.map((m) => (
                <div
                  key={m.id}
                  className="grid grid-cols-[auto_0.8fr_3fr_0.8fr] items-center gap-4 border-b border-[var(--rc-line-soft)] px-5 py-4 last:border-0"
                >
                  <input
                    type="checkbox"
                    aria-label={`Select memory record ${m.id}`}
                    checked={selectedMemory.has(m.id)}
                    onChange={() => toggleMemory(m.id)}
                    className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                  />
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
          </>
        )}

        {confirmDelete && (
          <Modal
            title={`Delete ${selectedMemory.size} memory record${selectedMemory.size === 1 ? "" : "s"}?`}
            subtitle="The agent will no longer recall them when classifying. This cannot be undone — the DynamoDB lessons ledger above keeps the underlying analyst decisions, but the consolidated memory is regenerated only from future decisions."
            onClose={() => setConfirmDelete(false)}
            className="max-w-xl"
          >
            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={deleteSelectedMemory}
                disabled={deleting}
                className="rc-mono rounded border border-[var(--rc-amber)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-amber)] hover:bg-[var(--rc-amber)] hover:text-[#140a00] disabled:opacity-40"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="rc-mono px-2 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)] disabled:opacity-40"
              >
                Cancel
              </button>
            </div>
          </Modal>
        )}
      </section>
    </div>
  );
}

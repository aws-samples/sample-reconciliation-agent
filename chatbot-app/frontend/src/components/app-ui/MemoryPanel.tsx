"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type {
  MemoryStrategyInfo,
  MemoryStrategyResponse,
} from "@/lib/memoryStrategy";
import {
  BTN_DANGER,
  BTN_LINK,
  Disclosure,
  Eyebrow,
  Modal,
  Notice,
  Panel,
  Placeholder,
} from "./ui";

// The memory panel every app mounts over its own `/api/<app>/memory` routes: the consolidated
// records an agent recalls, the read-only strategy that produced them, selection and confirmed
// deletion. The recon Lessons page mounts it for its memory half; the pipeline's Memory Manager wraps
// it with an "add a rule" form and a proposals link.
//
// What differs between the apps is passed in, never branched on: the columns (recon's records carry
// a `domain`), the three API calls, the header, the environment variable named in the
// "not configured" notes, the warning under the delete confirmation, and how the panel's own notes
// are drawn. Every default is the recon Lessons page's behaviour: everyone sees the selection controls
// (the route decides who may delete), no Refresh button, the memory text and its capture date as the
// columns, notes as dashed `Placeholder` boxes, a refused delete reported as "Delete failed — …" above
// the table, and a failed records load degrading to the empty state without a word.

/** The least a record must carry: the id the checkboxes key on, the text, and a sortable timestamp. */
export interface MemoryPanelRecord {
  id: string;
  content: string;
  createdAt: string;
}

/** What a delete answers: the ids that went, and the ones the service refused, with its reason. */
export interface MemoryPanelDeleteResult {
  deleted: string[];
  failed: { id: string; error: string }[];
}

/**
 * How the panel draws its own notes — a strategy that could not be read, a memory that is not
 * configured, a delete the service refused. `"placeholder"` is the dashed full-height box the recon
 * Lessons page uses; `"inline"` is the one-line `Notice` the pipeline's Memory Manager uses, where a
 * box per note would crowd the records out of a sidebar.
 */
export type MemoryPanelNoteStyle = "placeholder" | "inline";

/** One column of the records table. */
export interface MemoryPanelColumn<R extends MemoryPanelRecord> {
  key: string;
  header: string;
  /** The column's share of the row as a CSS grid track, e.g. `3fr`. */
  width: string;
  /** Class on the cell, for the app's text treatment. */
  className?: string;
  render: (record: R) => ReactNode;
}

/** The recon table minus its domain column: the memory text and the day it was captured. */
export const MEMORY_PANEL_DEFAULT_COLUMNS: readonly MemoryPanelColumn<MemoryPanelRecord>[] =
  [
    {
      key: "content",
      header: "Memory",
      width: "3fr",
      className: "text-[13px] text-[var(--rc-ink)]",
      render: (r) => r.content,
    },
    {
      key: "createdAt",
      header: "Captured",
      width: "0.8fr",
      className: "rc-mono text-[12px] text-[var(--rc-ink-dim)]",
      render: (r) => (r.createdAt ? r.createdAt.slice(0, 10) : "—"),
    },
  ];

export interface MemoryPanelProps<R extends MemoryPanelRecord> {
  /** `GET /api/<app>/memory`. */
  listRecords: () => Promise<R[]>;
  /** `DELETE /api/<app>/memory`; the panel keeps whatever `failed` names on screen. */
  deleteRecords: (ids: string[]) => Promise<MemoryPanelDeleteResult>;
  /** `GET /api/<app>/memory/strategy`. */
  getStrategy: () => Promise<MemoryStrategyResponse>;
  /** The environment variable that names the app's memory, for the "not configured" notes. */
  memoryIdEnvName: string;
  /** The line under the delete confirmation's title: what forgetting these records means here. */
  deleteWarning: ReactNode;
  /** Table columns; defaults to `MEMORY_PANEL_DEFAULT_COLUMNS`. */
  columns?: readonly MemoryPanelColumn<R>[];
  /**
   * Whether to show the checkboxes and the delete controls. Defaults to true: the route is what
   * refuses a non-admin, and its refusal is shown beside the records.
   */
  canDelete?: boolean;
  /** The title block above the panel. */
  header?: ReactNode;
  /** A link or badge on the header's right, e.g. a count of pending proposals. */
  headerLink?: ReactNode;
  /** Show a Refresh button beside `headerLink`. Off by default. */
  refresh?: boolean;
  /** Bumped by the parent to reload without remounting. */
  refreshToken?: number;
  /** Runs on every load — for companion data the header shows, so Refresh reloads it too. */
  onLoad?: () => void;
  /** Rendered under the records, e.g. a form that writes a new rule. */
  addRule?: ReactNode;
  /** How the panel's notes are drawn. Defaults to `"placeholder"`, the recon page's dashed box. */
  noteStyle?: MemoryPanelNoteStyle;
  /** The words before a refused delete's reason. Defaults to the recon page's `"Delete failed — "`. */
  deleteErrorLabel?: string;
  /**
   * Whether a failed records load is reported beside the empty table. Off by default: the recon page
   * treats long-term memory as advisory context and degrades to the empty state without a word.
   */
  showLoadError?: boolean;
  className?: string;
}

const STRATEGY_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "var(--rc-green)",
  CREATING: "var(--rc-cyan)",
  DELETING: "var(--rc-amber)",
  FAILED: "var(--rc-red)",
};

/** One of the panel's own notes, in the caller's style: an error, or a quiet "nothing here". */
function Note({
  style,
  tone,
  children,
}: {
  style: MemoryPanelNoteStyle;
  tone: "error" | "empty";
  children: ReactNode;
}) {
  if (style === "placeholder") {
    return <Placeholder kind={tone}>{children}</Placeholder>;
  }
  return tone === "error" ? (
    <Notice tone="error" className="text-[11.5px]">
      {children}
    </Notice>
  ) : (
    <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{children}</p>
  );
}

/** One row of key/value metadata inside an expanded strategy. */
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
 * @param strategy the flattened strategy projection from `GET /api/<app>/memory/strategy`.
 */
export function StrategyCard({ strategy }: { strategy: MemoryStrategyInfo }) {
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

export function MemoryPanel<R extends MemoryPanelRecord>({
  listRecords,
  deleteRecords,
  getStrategy,
  memoryIdEnvName,
  deleteWarning,
  columns = MEMORY_PANEL_DEFAULT_COLUMNS,
  canDelete = true,
  header,
  headerLink,
  refresh = false,
  refreshToken = 0,
  onLoad,
  addRule,
  noteStyle = "placeholder",
  deleteErrorLabel = "Delete failed — ",
  showLoadError = false,
  className = "",
}: MemoryPanelProps<R>) {
  const [records, setRecords] = useState<R[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  // The live extraction strategy behind the records. Read-only — see StrategyCard.
  const [strategy, setStrategy] = useState<MemoryStrategyResponse | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  // Selection lives here rather than in the row, so the action bar can name a count.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Delete failures only. A load failure is kept apart, and shown only when the caller asks.
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The callbacks are read through a ref so `load` is stable: a caller passing fresh lambdas on every
  // render must not make the panel reload on every render.
  const latest = useRef({ listRecords, getStrategy, onLoad });
  latest.current = { listRecords, getStrategy, onLoad };

  const load = useCallback(() => {
    const api = latest.current;
    // Both load errors reset together. The error branch wins over a loaded strategy, so a stale error
    // from one transient failure would otherwise mask every later successful reload.
    setRecordsError(null);
    setStrategyError(null);
    api
      .listRecords()
      .then((m) =>
        setRecords(
          [...m].sort((a, b) =>
            (b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
          ),
        ),
      )
      .catch((e) => {
        // Advisory context degrades to an empty list; it never takes the rest of the page with it.
        // The reason is kept for the callers that choose to show it (`showLoadError`).
        setRecords([]);
        setRecordsError(String(e));
      });
    // Fetched independently: a missing GetMemory grant shows as a note on the card, not an empty list.
    api
      .getStrategy()
      .then(setStrategy)
      .catch((e) => setStrategyError(String(e)));
    api.onLoad?.();
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  /** Add or remove one record from the selection. */
  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Select every loaded record, or clear the selection when all of them are already selected. */
  function toggleAll(): void {
    setSelected((prev) =>
      prev.size === (records?.length ?? 0)
        ? new Set()
        : new Set((records ?? []).map((r) => r.id)),
    );
  }

  /**
   * Delete the selected records, then drop them from the table.
   *
   * Only the ids the service confirms are removed locally. A record the service refused stays on
   * screen, still selected, with its reason shown — hiding it would tell the operator it is gone when
   * the agent will still recall it.
   */
  async function removeSelected(): Promise<void> {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteRecords([...selected]);
      const gone = new Set(result.deleted);
      setRecords((prev) => (prev ?? []).filter((r) => !gone.has(r.id)));
      setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      if (result.failed.length > 0) {
        setDeleteError(
          result.failed.map((f) => `${f.id}: ${f.error}`).join("; "),
        );
      }
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const gridTemplateColumns = `${canDelete ? "auto " : ""}${columns
    .map((c) => c.width)
    .join(" ")}`;

  return (
    <section className={`space-y-4 ${className}`}>
      {(header || headerLink || refresh) && (
        <div className="flex flex-wrap items-start justify-between gap-3">
          {header}
          {(headerLink || refresh) && (
            <div className="ml-auto flex items-center gap-2">
              {headerLink}
              {refresh && (
                <button
                  type="button"
                  onClick={load}
                  className={BTN_LINK}
                  title="Reload records and strategy"
                >
                  Refresh
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* What produced the records below: the live strategy and the prompt that decides what counts
          as a record. Read from the memory itself rather than restated from Terraform, so it cannot
          drift from what is actually running. */}
      {strategyError ? (
        <Note style={noteStyle} tone="error">
          Could not read the memory strategy — {strategyError}
        </Note>
      ) : strategy && !strategy.configured ? (
        <Note style={noteStyle} tone="empty">
          {memoryIdEnvName} not configured — no strategy to show.
        </Note>
      ) : strategy && strategy.strategies.length > 0 ? (
        <div className="space-y-2">
          <Eyebrow>
            Extraction strategy · read-only
            {strategy.memoryStatus ? ` · memory ${strategy.memoryStatus}` : ""}
          </Eyebrow>
          {strategy.strategies.map((s) => (
            <StrategyCard key={s.id} strategy={s} />
          ))}
        </div>
      ) : null}

      <div className="space-y-4" data-testid="memory-records">
        {showLoadError && recordsError && (
          <Note style={noteStyle} tone="error">
            Could not load records — {recordsError}
          </Note>
        )}

        {/* A refused delete sits above the table, where the recon page put it: beside the action bar
            that asked for it, and above the record it left in place. */}
        {deleteError && (
          <Note style={noteStyle} tone="error">
            {deleteErrorLabel}
            {deleteError}
          </Note>
        )}

        {!records ? (
          <Placeholder kind="loading">◆ loading memory…</Placeholder>
        ) : records.length === 0 ? (
          <Placeholder kind="empty">
            No consolidated memory yet — or {memoryIdEnvName} not configured.
          </Placeholder>
        ) : (
          <>
            {canDelete && selected.size > 0 && (
              <Panel className="rc-rise flex flex-wrap items-center gap-3 p-4">
                <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
                  {selected.size} selected
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className={BTN_DANGER}
                >
                  Delete selected
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className={BTN_LINK}
                >
                  Clear
                </button>
              </Panel>
            )}

            <Panel className="rc-rise overflow-hidden">
              <div
                className="grid gap-4 border-b border-[var(--rc-line)] px-5 py-3"
                style={{ gridTemplateColumns }}
              >
                {canDelete && (
                  <input
                    type="checkbox"
                    aria-label="Select all memory records"
                    checked={
                      selected.size > 0 && selected.size === records.length
                    }
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                  />
                )}
                {columns.map((c) => (
                  <div key={c.key} className="rc-eyebrow">
                    {c.header}
                  </div>
                ))}
              </div>
              {records.map((r) => (
                <div
                  key={r.id}
                  className="grid items-center gap-4 border-b border-[var(--rc-line-soft)] px-5 py-4 last:border-0"
                  style={{ gridTemplateColumns }}
                >
                  {canDelete && (
                    <input
                      type="checkbox"
                      aria-label={`Select memory record ${r.id}`}
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      className="h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                    />
                  )}
                  {columns.map((c) => (
                    <div key={c.key} className={c.className}>
                      {c.render(r)}
                    </div>
                  ))}
                </div>
              ))}
            </Panel>
          </>
        )}
      </div>

      {addRule}

      {confirmDelete && (
        <Modal
          title={`Delete ${selected.size} memory record${selected.size === 1 ? "" : "s"}?`}
          subtitle={deleteWarning}
          onClose={() => setConfirmDelete(false)}
          className="max-w-xl"
        >
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={removeSelected}
              disabled={deleting}
              className={BTN_DANGER}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className={BTN_LINK}
            >
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

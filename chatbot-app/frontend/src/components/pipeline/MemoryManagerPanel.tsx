"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  addMemory,
  deleteMemory,
  getMemoryStrategy,
  listMemory,
  listProposals,
  type MemoryStrategyInfo,
  type MemoryStrategyResponse,
} from "@/lib/pipelineApi";
import type { MemoryRecord } from "@/lib/pipeline/types";
import { formatDateTime } from "@/components/pipeline/format";
import {
  BTN_DANGER,
  BTN_LINK,
  BTN_PRIMARY,
  BTN_QUIET,
  Disclosure,
  Eyebrow,
  INPUT_CLASS,
  Modal,
  Notice,
  Panel,
  Placeholder,
  type ActionOutcome,
} from "@/components/app-ui/ui";

// The situational tier of the learning loop, made visible. Records are what the parser recalls
// before its first model call; the strategy card shows the extraction prompt that decides what
// counts as a rule; the proposals count points at the other tier so the two are never confused.

const STRATEGY_STATUS_COLOR: Record<string, string> = {
  ACTIVE: "var(--rc-green)",
  CREATING: "var(--rc-cyan)",
  DELETING: "var(--rc-amber)",
  FAILED: "var(--rc-red)",
};

/** One row of key/value metadata inside an expanded strategy. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="rc-eyebrow">{label}</div>
      <div className="rc-mono mt-1 break-all text-[12px] text-[var(--rc-ink)]">{value}</div>
    </div>
  );
}

/**
 * One strategy as a collapsed disclosure: identity and status on the row, the prompt inside.
 *
 * Read-only throughout. The strategy is owned by Terraform, and changing its `type` replaces it —
 * which deletes every record in the list below — so this surface reports and never edits.
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
            style={{ color: STRATEGY_STATUS_COLOR[strategy.status] ?? "var(--rc-ink-dim)" }}
          >
            {strategy.status}
          </span>
        </span>
      }
      meta={phases.length === 0 ? "built-in prompt" : "read-only"}
    >
      <div className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Namespaces" value={strategy.namespaces.join(", ") || "—"} />
          <Field label="Extraction model" value={strategy.extraction?.modelId ?? "—"} />
        </div>
        {strategy.description && <Field label="Description" value={strategy.description} />}
        {phases.length === 0 ? (
          <Placeholder kind="empty">
            No prompt override — this strategy runs the service&rsquo;s built-in instructions, which
            it does not expose.
          </Placeholder>
        ) : (
          phases.map((p) => (
            <div key={p.label}>
              <Eyebrow>
                {p.label} · {p.override!.kind}
              </Eyebrow>
              <pre className="mt-2 max-h-[320px] overflow-auto whitespace-pre-wrap rounded bg-[var(--rc-panel-2)] p-4 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                <code className="rc-mono">{p.override!.appendToPrompt}</code>
              </pre>
            </div>
          ))
        )}
      </div>
    </Disclosure>
  );
}

export function MemoryManagerPanel({
  isAdmin,
  refreshToken = 0,
}: {
  isAdmin: boolean;
  /** Bumped by the parent after each assistant turn; the panel reloads when it changes. */
  refreshToken?: number;
}) {
  const [records, setRecords] = useState<MemoryRecord[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<MemoryStrategyResponse | null>(null);
  const [strategyError, setStrategyError] = useState<string | null>(null);
  const [pendingProposals, setPendingProposals] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [rule, setRule] = useState("");
  const [adding, setAdding] = useState(false);
  // Two outcomes, not one: a refused delete belongs beside the records it refused to remove, and a
  // save belongs beside the box it was typed in. One shared line put delete failures under "Add a
  // rule", in the confirmation colour.
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [addOutcome, setAddOutcome] = useState<ActionOutcome | null>(null);

  const load = useCallback(() => {
    // Both load errors reset together. The strategy branch below wins over the loaded strategy, so a
    // stale error from one transient failure would otherwise mask every later successful reload.
    setRecordsError(null);
    setStrategyError(null);
    listMemory()
      .then((m) =>
        setRecords([...m].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))),
      )
      .catch((e) => {
        setRecords([]);
        setRecordsError(String(e));
      });
    // Fetched independently: a missing GetMemory grant shows as a note on the card, not an empty list.
    getMemoryStrategy()
      .then(setStrategy)
      .catch((e) => setStrategyError(String(e)));
    // Advisory: the count is a pointer to the other tier, so a failure here just hides the number.
    listProposals("PENDING")
      .then((p) => setPendingProposals(p.length))
      .catch(() => setPendingProposals(null));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const removeSelected = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      const result = await deleteMemory([...selected]);
      const gone = new Set(result.deleted);
      // Only the ids the service confirms leave the list. A record it refused stays visible with the
      // reason, because hiding it would say "gone" while the parser still recalls it.
      setRecords((prev) => (prev ?? []).filter((r) => !gone.has(r.id)));
      setSelected(new Set([...selected].filter((id) => !gone.has(id))));
      if (result.failed.length > 0)
        setDeleteError(result.failed.map((f) => `${f.id}: ${f.error}`).join("; "));
    } catch (e) {
      setDeleteError(String(e));
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const add = async () => {
    const text = rule.trim();
    if (!text) return;
    setAdding(true);
    setAddOutcome(null);
    try {
      await addMemory(text);
      setRule("");
      setAddOutcome({
        tone: "success",
        text: "Saved. The consolidated record appears once the extraction pass has run — usually under a minute; refresh to check.",
      });
    } catch (e) {
      setAddOutcome({ tone: "error", text: String(e) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Panel className="rc-rise space-y-5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>Memory manager · situational rules</Eyebrow>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
            Edge cases the parser recalls before reading an email. Universal rules belong in a skill
            instead — see the proposals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/pipeline/skills/proposals" className={BTN_QUIET}>
            Proposals
            {pendingProposals !== null && pendingProposals > 0 && (
              <span className="ml-2 text-[var(--rc-amber)]">{pendingProposals} pending</span>
            )}
          </Link>
          <button type="button" onClick={load} className={BTN_LINK} title="Reload records, strategy and proposals">
            Refresh
          </button>
        </div>
      </div>

      {/* The strategy that produced the records. Read from the memory itself so it cannot drift. */}
      {strategyError ? (
        <p className="rc-mono text-[11px] text-[var(--rc-amber)]">
          Could not read the memory strategy — {strategyError}
        </p>
      ) : strategy && !strategy.configured ? (
        <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          KNOWLEDGE_MEMORY_ID not configured — no strategy to show.
        </p>
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

      {/* Records */}
      <div className="space-y-2" data-testid="memory-records">
        <div className="flex items-center justify-between">
          <Eyebrow>Consolidated records</Eyebrow>
          {records && <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{records.length}</span>}
        </div>
        {recordsError && (
          <p className="rc-mono text-[11px] text-[var(--rc-amber)]">Could not load records — {recordsError}</p>
        )}
        {!records ? (
          <Placeholder kind="loading">◆ loading memory…</Placeholder>
        ) : records.length === 0 ? (
          <Placeholder kind="empty">◇ no consolidated memory yet</Placeholder>
        ) : (
          <div className="overflow-hidden rounded border border-[var(--rc-line)]">
            {records.map((r) => (
              <label
                key={r.id}
                className="flex items-start gap-3 border-b border-[var(--rc-line-soft)] px-3 py-2.5 last:border-0 hover:bg-[var(--rc-panel-2)]"
              >
                {isAdmin && (
                  <input
                    type="checkbox"
                    aria-label={`Select memory record ${r.id}`}
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    className="mt-1 h-3.5 w-3.5 accent-[var(--rc-cyan)]"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-relaxed text-[var(--rc-ink)]">{r.content}</span>
                  <span className="rc-mono mt-0.5 block text-[10.5px] text-[var(--rc-ink-faint)]">
                    {formatDateTime(r.createdAt)} · {r.namespace}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
        {isAdmin && selected.size > 0 && (
          <div className="flex items-center gap-3">
            <span className="rc-mono text-[12px] text-[var(--rc-ink)]">{selected.size} selected</span>
            <button type="button" onClick={() => setConfirmDelete(true)} className={BTN_DANGER}>
              Delete selected
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className={BTN_LINK}>
              Clear
            </button>
          </div>
        )}
        {deleteError && (
          <Notice tone="error" className="text-[11.5px]">
            Not deleted — {deleteError}
          </Notice>
        )}
      </div>

      {/* Manual add */}
      <div className="space-y-2 border-t border-[var(--rc-line)] pt-4">
        <Eyebrow>Add a rule</Eyebrow>
        <textarea
          aria-label="New memory rule"
          value={rule}
          onChange={(e) => setRule(e.target.value)}
          rows={3}
          placeholder="e.g. Project-finance term loans from this arranger are First Lien in the OMS even when the notice says Senior Secured."
          className={`${INPUT_CLASS} w-full leading-relaxed`}
        />
        <div className="flex items-center gap-3">
          <button type="button" onClick={add} disabled={adding || !rule.trim()} className={BTN_PRIMARY}>
            {adding ? "Saving…" : "Save to memory"}
          </button>
          {addOutcome && (
            <Notice tone={addOutcome.tone} className="text-[11.5px]">
              {addOutcome.text}
            </Notice>
          )}
        </div>
      </div>

      {confirmDelete && (
        <Modal
          title={`Delete ${selected.size} memory record${selected.size === 1 ? "" : "s"}?`}
          subtitle="The parser will no longer recall them. This cannot be undone; the rule can be re-added by hand or re-learned from a future conversation."
          onClose={() => setConfirmDelete(false)}
          className="max-w-xl"
        >
          <div className="flex items-center gap-3">
            <button type="button" onClick={removeSelected} disabled={deleting} className={BTN_DANGER}>
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} className={BTN_LINK}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

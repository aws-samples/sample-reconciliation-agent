"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  addMemory,
  deleteMemory,
  getMemoryStrategy,
  listMemory,
  listProposals,
} from "@/lib/pipelineApi";
import type { MemoryRecord } from "@/lib/pipeline/types";
import { fieldDef } from "@/lib/pipeline/omsSchema";
import { formatDateTime } from "@/components/pipeline/format";
import {
  MemoryPanel,
  type MemoryPanelColumn,
} from "@/components/app-ui/MemoryPanel";
import {
  BTN_PRIMARY,
  BTN_QUIET,
  Eyebrow,
  INPUT_CLASS,
  Notice,
  Panel,
  type ActionOutcome,
} from "@/components/app-ui/ui";

// The situational tier of the learning loop, made visible: the shared memory panel over the
// pipeline's memory routes, plus what is the pipeline's own — where each lesson came from (the
// override, reviewer and deal that taught it), filters over that, a warning when several lessons
// speak to one field, the proposals count that points at the other tier so the two are never
// confused, and the form that writes a rule by hand.
//
// Overrides teach the parser without review, so this is where a bad lesson is found and pruned. The
// extraction never merges lessons — even a contradicting one is added beside the old — so two
// lessons about one field is the shape a conflict takes, and it is surfaced rather than left for the
// parser to resolve.

/** The label of the OMS field a lesson came from, or null for a rule saved another way. */
function fieldOf(r: MemoryRecord): string | null {
  return r.source?.field ?? null;
}

function labelOf(field: string): string {
  return fieldDef(field)?.label ?? field;
}

/** Under the rule: who taught it and from which override, or that it was saved another way. */
function SourceLine({ record }: { record: MemoryRecord }) {
  const s = record.source;
  return (
    <span className="rc-mono mt-1 block text-[10.5px] leading-relaxed text-[var(--rc-ink-faint)]" data-source={s ? s.override_id : "other"}>
      {s ? (
        <>
          <span className="text-[var(--rc-violet)]">override</span> by {s.author || "unknown"}
          {s.field && <> · {labelOf(s.field)}</>}
          {" on "}
          <Link href={`/pipeline/deals/${encodeURIComponent(s.deal_id)}`} className="text-[var(--rc-cyan)] hover:underline">
            {s.opportunity_name || s.deal_id}
          </Link>
          {s.reason && <span className="block text-[var(--rc-ink-dim)]">&ldquo;{s.reason}&rdquo;</span>}
        </>
      ) : (
        <>saved by hand or by the assistant</>
      )}
      <span className="block">
        {formatDateTime(record.createdAt)} · {record.namespace}
      </span>
    </span>
  );
}

type SourceFilter = "all" | "override" | "other";

const SELECT_CLASS = `${INPUT_CLASS} py-1 text-[11.5px]`;

/**
 * Save a rule by hand — the same event the assistant's `save_memory` writes.
 *
 * The outcome sits beside the box it was typed in, in a colour that says which way it went: a refused
 * save drawn like a confirmation is a rule the parser will never recall.
 */
function AddRuleForm() {
  const [rule, setRule] = useState("");
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<ActionOutcome | null>(null);

  const add = async () => {
    const text = rule.trim();
    if (!text) return;
    setAdding(true);
    setOutcome(null);
    try {
      await addMemory(text);
      setRule("");
      setOutcome({
        tone: "success",
        text: "Saved. The consolidated record appears once the extraction pass has run — usually under a minute; refresh to check.",
      });
    } catch (e) {
      setOutcome({ tone: "error", text: String(e) });
    } finally {
      setAdding(false);
    }
  };

  return (
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
        <button
          type="button"
          onClick={add}
          disabled={adding || !rule.trim()}
          className={BTN_PRIMARY}
        >
          {adding ? "Saving…" : "Save to memory"}
        </button>
        {outcome && (
          <Notice tone={outcome.tone} className="text-[11.5px]">
            {outcome.text}
          </Notice>
        )}
      </div>
    </div>
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
  const [pendingProposals, setPendingProposals] = useState<number | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [source, setSource] = useState<SourceFilter>("all");
  const [author, setAuthor] = useState("");
  const [field, setField] = useState("");

  const authors = useMemo(
    () => [...new Set(records.map((r) => r.source?.author).filter((a): a is string => !!a))].sort(),
    [records],
  );
  const perField = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of records) {
      const f = fieldOf(r);
      if (f) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return counts;
  }, [records]);
  const crowded = [...perField].filter(([, n]) => n > 1);

  const visible = useCallback(
    (r: MemoryRecord) =>
      (source === "all" || (source === "override") === Boolean(r.source)) &&
      (!author || r.source?.author === author) &&
      (!field || fieldOf(r) === field),
    [source, author, field],
  );

  const columns = useMemo<MemoryPanelColumn<MemoryRecord>[]>(
    () => [
      {
        key: "rule",
        header: "Consolidated records",
        width: "1fr",
        render: (r) => {
          const f = fieldOf(r);
          const n = f ? (perField.get(f) ?? 0) : 0;
          return (
            <>
              <span className="block text-[12.5px] leading-relaxed text-[var(--rc-ink)]">
                {r.content}
              </span>
              {n > 1 && (
                <span className="rc-mono mt-1 block text-[10.5px]" style={{ color: "var(--rc-amber)" }}>
                  one of {n} lessons about {labelOf(f!)} — check they agree
                </span>
              )}
              <SourceLine record={r} />
            </>
          );
        },
      },
    ],
    [perField],
  );

  const toolbar = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Filter by source" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)} className={SELECT_CLASS}>
          <option value="all">every source</option>
          <option value="override">taught by an override</option>
          <option value="other">saved by hand or assistant</option>
        </select>
        <select aria-label="Filter by author" value={author} onChange={(e) => setAuthor(e.target.value)} className={SELECT_CLASS}>
          <option value="">every author</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select aria-label="Filter by field" value={field} onChange={(e) => setField(e.target.value)} className={SELECT_CLASS}>
          <option value="">every field</option>
          {[...perField.keys()].sort((a, b) => labelOf(a).localeCompare(labelOf(b))).map((f) => (
            <option key={f} value={f}>
              {labelOf(f)} ({perField.get(f)})
            </option>
          ))}
        </select>
      </div>
      {crowded.map(([f, n]) => (
        <p
          key={f}
          role="status"
          className="rc-mono border-l-2 border-[var(--rc-amber)] pl-2 text-[11.5px] leading-relaxed"
          style={{ color: "var(--rc-amber)" }}
        >
          {n} lessons about {labelOf(f)} — extraction adds a contradicting lesson beside the old one
          rather than replacing it, so check they agree.{" "}
          <button type="button" onClick={() => setField(f)} className="underline">
            Show them
          </button>
        </p>
      ))}
    </div>
  );

  // Advisory: the count is a pointer to the other tier, so a failure here just hides the number.
  // Runs on every load of the panel — first mount, a parent's refreshToken, the Refresh button.
  const loadProposals = useCallback(() => {
    listProposals("PENDING")
      .then((p) => setPendingProposals(p.length))
      .catch(() => setPendingProposals(null));
  }, []);

  return (
    <Panel className="rc-rise p-5">
      <MemoryPanel
        listRecords={listMemory}
        deleteRecords={deleteMemory}
        getStrategy={getMemoryStrategy}
        columns={columns}
        visible={visible}
        toolbar={toolbar}
        onRecords={setRecords}
        canDelete={isAdmin}
        memoryIdEnvName="KNOWLEDGE_MEMORY_ID"
        header={
          <div>
            <Eyebrow>Memory manager · situational rules</Eyebrow>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
              Edge cases the parser recalls before reading an email. Universal
              rules belong in a skill instead — see the proposals.
            </p>
          </div>
        }
        headerLink={
          <Link href="/pipeline/skills/proposals" className={BTN_QUIET}>
            Proposals
            {pendingProposals !== null && pendingProposals > 0 && (
              <span className="ml-2 text-[var(--rc-amber)]">
                {pendingProposals} pending
              </span>
            )}
          </Link>
        }
        refresh
        refreshToken={refreshToken}
        onLoad={loadProposals}
        addRule={<AddRuleForm />}
        // One-line notes rather than the shared default's dashed boxes: this panel sits in a sidebar
        // beside the assistant, where a 220px box per note would push the records out of view.
        noteStyle="inline"
        deleteErrorLabel="Not deleted — "
        showLoadError
        deleteWarning="The parser will no longer recall them, and any override that taught one is marked as retracted on its deal. This cannot be undone; the rule can be re-added by hand or re-learned from a future conversation or override."
      />
    </Panel>
  );
}

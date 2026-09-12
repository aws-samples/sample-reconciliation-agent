"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  addMemory,
  deleteMemory,
  getMemoryStrategy,
  listMemory,
  listProposals,
} from "@/lib/pipelineApi";
import type { MemoryRecord } from "@/lib/pipeline/types";
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
// pipeline's memory routes, plus what is the pipeline's own — the proposals count that points at the
// other tier so the two are never confused, and the form that writes a rule by hand.

// One wide column: the rule, with when it was captured and where it lives underneath.
const COLUMNS: MemoryPanelColumn<MemoryRecord>[] = [
  {
    key: "rule",
    header: "Consolidated records",
    width: "1fr",
    render: (r) => (
      <>
        <span className="block text-[12.5px] leading-relaxed text-[var(--rc-ink)]">
          {r.content}
        </span>
        <span className="rc-mono mt-0.5 block text-[10.5px] text-[var(--rc-ink-faint)]">
          {formatDateTime(r.createdAt)} · {r.namespace}
        </span>
      </>
    ),
  },
];

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
        columns={COLUMNS}
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
        deleteWarning="The parser will no longer recall them. This cannot be undone; the rule can be re-added by hand or re-learned from a future conversation."
      />
    </Panel>
  );
}

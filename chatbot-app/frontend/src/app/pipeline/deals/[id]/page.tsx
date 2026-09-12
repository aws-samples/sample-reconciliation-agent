"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  approveDeal,
  getDeal,
  getDealCsv,
  rejectDeal,
  updateDealFields,
} from "@/lib/pipelineApi";
import type { DealRecord, FieldValues } from "@/lib/pipeline/types";
import { changedKeys, toCsv, validateFields } from "@/lib/pipeline/omsSchema";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import { DealFieldGrid } from "@/components/pipeline/DealFieldGrid";
import { UploadResultPanel } from "@/components/pipeline/UploadResultPanel";
import { formatDateTime } from "@/components/pipeline/format";
import {
  BTN_CONFIRM,
  BTN_DANGER,
  BTN_LINK,
  BTN_QUIET,
  Disclosure,
  Eyebrow,
  INPUT_CLASS,
  Modal,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";
import { StatusPill } from "@/components/pipeline/ui";

const HISTORY_COLOR: Record<string, string> = {
  STAGED: "var(--rc-cyan)",
  EDITED: "var(--rc-violet)",
  APPROVED: "var(--rc-violet)",
  UPLOAD_ACCEPTED: "var(--rc-green)",
  UPLOAD_REJECTED: "var(--rc-red)",
  REJECTED: "var(--rc-red)",
};

/** Whether a person can still act on the deal: approve, reject or edit. */
function decidable(status: DealRecord["status"]): boolean {
  return status === "STAGED" || status === "UPLOAD_FAILED";
}

/** Hand the browser a file to save. */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isAdmin } = usePipelineSubject();
  const [deal, setDeal] = useState<DealRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Non-null while editing. The grid edits this copy; Save sends it, Cancel drops it.
  const [draft, setDraft] = useState<FieldValues | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const load = useCallback(
    () =>
      getDeal(id)
        .then(setDeal)
        .catch((e) => setError(String(e))),
    [id],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Validation runs on the draft as it is typed, with the same rules the PATCH applies server-side.
  const problems = useMemo(() => (draft ? validateFields(draft) : {}), [draft]);
  const problemCount = Object.keys(problems).length;

  const csv = useMemo(() => (deal ? toCsv(draft ?? deal.fields) : ""), [deal, draft]);

  if (error) return <Placeholder kind="error">Failed to load the deal — {error}</Placeholder>;
  if (!deal) return <Placeholder kind="loading">◆ loading deal {id}…</Placeholder>;

  const editing = draft !== null;
  const open = decidable(deal.status);
  const edited = changedKeys(deal.original_fields, deal.fields);

  const run = async (label: string, action: () => Promise<DealRecord | void>) => {
    setBusy(label);
    setActionError(null);
    try {
      const next = await action();
      if (next) setDeal(next);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", async () => {
      const next = await updateDealFields(id, draft!);
      setDraft(null);
      return next;
    });

  const reject = () =>
    run("reject", async () => {
      const next = await rejectDeal(id, reason.trim());
      setRejecting(false);
      setReason("");
      return next;
    });

  const download = () =>
    run("download", async () => {
      downloadText(`${deal.deal_id}.csv`, await getDealCsv(id));
    });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Link
          href="/pipeline/deals"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
        >
          ← Deals
        </Link>
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{deal.deal_id}</span>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Eyebrow>Deal review</Eyebrow>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <h1 className="rc-display text-[30px] font-black leading-none text-[var(--rc-ink)]">
              {deal.opportunity_name || "Untitled deal"}
            </h1>
            <StatusPill status={deal.status} />
          </div>
          <p className="rc-mono mt-2 text-[11.5px] text-[var(--rc-ink-faint)]">
            from{" "}
            <Link
              href={`/pipeline/inbox/${encodeURIComponent(deal.email_id)}`}
              className="text-[var(--rc-cyan)] hover:underline"
            >
              email {deal.email_id}
            </Link>
            {" · "}created {formatDateTime(deal.created_at)}
            {edited.length > 0 && (
              <>
                {" · "}
                <span className="text-[var(--rc-violet)]">
                  {edited.length} field{edited.length === 1 ? "" : "s"} edited since parsing
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={busy !== null || problemCount > 0}
                className={BTN_CONFIRM}
                title={problemCount > 0 ? `${problemCount} field(s) still invalid` : undefined}
              >
                {busy === "save" ? "Saving…" : "Save"}
              </button>
              <button type="button" onClick={() => setDraft(null)} disabled={busy !== null} className={BTN_LINK}>
                Cancel
              </button>
            </>
          ) : (
            <>
              {open && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...deal.fields })}
                  disabled={busy !== null}
                  className={BTN_QUIET}
                >
                  Edit fields
                </button>
              )}
              <button type="button" onClick={download} disabled={busy !== null} className={BTN_QUIET}>
                {busy === "download" ? "Preparing…" : "Download CSV"}
              </button>
              {open && isAdmin && (
                <>
                  <button
                    type="button"
                    onClick={() => run("approve", () => approveDeal(id))}
                    disabled={busy !== null}
                    className={BTN_CONFIRM}
                    title="Approve and send the staging file to the OMS"
                  >
                    {busy === "approve" ? "Uploading…" : "Approve & upload"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRejecting(true)}
                    disabled={busy !== null}
                    className={BTN_DANGER}
                  >
                    Reject
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </header>

      {open && !isAdmin && (
        <p className="rc-mono text-[11.5px] text-[var(--rc-ink-faint)]">
          Approving or rejecting requires membership of the admin group; fields can still be edited.
        </p>
      )}
      {actionError && <Placeholder kind="error">{actionError}</Placeholder>}
      {editing && problemCount > 0 && (
        <p className="rc-mono text-[12px]" style={{ color: "var(--rc-red)" }}>
          {problemCount} field{problemCount === 1 ? "" : "s"} would be rejected by the OMS — fix
          them to save.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Eyebrow>OMS staging fields · {editing ? "editing" : "as staged"}</Eyebrow>
          <DealFieldGrid
            fields={draft ?? deal.fields}
            original={deal.original_fields}
            evidence={deal.evidence}
            editing={editing}
            problems={problems}
            onChange={(key, value) => setDraft((d) => ({ ...(d ?? deal.fields), [key]: value }))}
          />
        </div>

        <div className="space-y-6">
          <UploadResultPanel upload={deal.upload} dealId={deal.deal_id} />

          <Panel className="rc-rise p-5">
            <Eyebrow>Staging CSV · {editing ? "preview of the draft" : deal.csv_key}</Eyebrow>
            <pre className="rc-mono mt-3 max-h-[260px] overflow-auto whitespace-pre rounded bg-[var(--rc-panel-2)] p-3 text-[11px] leading-relaxed text-[var(--rc-ink)]">
              {csv}
            </pre>
          </Panel>

          <Panel className="rc-rise p-5">
            <Eyebrow>History</Eyebrow>
            <ol className="mt-3 space-y-3">
              {[...deal.history].reverse().map((h, i) => (
                <li key={`${h.at}-${i}`} className="grid grid-cols-[auto_1fr] gap-3">
                  <span
                    className="mt-1.5 inline-block h-2 w-2 rounded-full"
                    style={{
                      background: HISTORY_COLOR[h.action] ?? "var(--rc-ink-faint)",
                      boxShadow: `0 0 6px ${HISTORY_COLOR[h.action] ?? "transparent"}`,
                    }}
                  />
                  <div>
                    <div className="rc-mono text-[12px] text-[var(--rc-ink)]">
                      {h.action.replace(/_/g, " ")}
                      <span className="text-[var(--rc-ink-faint)]"> · {h.actor}</span>
                    </div>
                    <div className="rc-mono text-[10.5px] text-[var(--rc-ink-faint)]">
                      {formatDateTime(h.at)}
                    </div>
                    {h.detail && (
                      <div className="mt-1 text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
                        {h.detail}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Panel>

          <Disclosure
            summary={
              <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
                Parse context
                <span className="text-[var(--rc-ink-faint)]">
                  {" "}· {deal.assumptions.length} assumption{deal.assumptions.length === 1 ? "" : "s"}
                  {" "}· {deal.memory_hits.length} memor{deal.memory_hits.length === 1 ? "y" : "ies"} recalled
                </span>
              </span>
            }
          >
            <div className="space-y-3 p-4">
              <div>
                <Eyebrow>Skills</Eyebrow>
                <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink)]">
                  {deal.skills_used.join(", ") || "—"}
                </p>
              </div>
              <div>
                <Eyebrow>Memories recalled</Eyebrow>
                {deal.memory_hits.length === 0 ? (
                  <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink-faint)]">none</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {deal.memory_hits.map((m, i) => (
                      <li key={m.record_id ?? i} className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
                        {m.text}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <Eyebrow>Assumptions</Eyebrow>
                {deal.assumptions.length === 0 ? (
                  <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink-faint)]">none</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {deal.assumptions.map((a, i) => (
                      <li key={i} className="border-l-2 border-[var(--rc-amber)] pl-3 text-[12px] leading-relaxed text-[var(--rc-ink)]">
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </Disclosure>
        </div>
      </div>

      {rejecting && (
        <Modal
          title="Reject this deal?"
          subtitle="The deal leaves the review queue and nothing is sent to the OMS. The reason is recorded in the deal's history."
          onClose={() => setRejecting(false)}
          className="max-w-xl"
        >
          <textarea
            aria-label="Rejection reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Why this deal is not going into the pipeline…"
            className={`${INPUT_CLASS} w-full leading-relaxed`}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={reject}
              disabled={busy !== null || !reason.trim()}
              className={BTN_DANGER}
            >
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" onClick={() => setRejecting(false)} disabled={busy !== null} className={BTN_LINK}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

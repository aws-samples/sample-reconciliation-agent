"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  approveCase,
  decideEmailDraft,
  getCase,
  getCaseEvals,
  getConfig,
  rejectCase,
  saveEmailDraft,
  type CaseEvals,
  type CaseEvalRecord,
  type ReconCase,
  retryCase,
  cancelCase,
} from "@/lib/reconApi";
import { getStoredAccessToken } from "@/lib/reconToken";
import {
  ConfidenceMeter,
  Eyebrow,
  Panel,
  Placeholder,
  StatusPill,
} from "@/components/recon/ui";
import { IdpDocumentPanel } from "@/components/recon/IdpDocumentPanel";
import { EmailDraftPanel } from "@/components/recon/EmailDraftPanel";

/**
 * Coerce a step's `evidence` into a clean string[] for rendering.
 *
 * The backend now normalizes evidence, but cases persisted BEFORE that fix stored a
 * JSON-encoded string (e.g. '["issuer: X", "facility: Y"]') where the schema promises an
 * array. React rendered such a string one bordered box per CHARACTER. This guard decodes a
 * JSON-array string back to an array, treats any other string as a single item, and never
 * splits a string into characters — so old and new cases both render correctly.
 */
function normalizeEvidence(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((e) => String(e)).filter((e) => e.length > 0);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((e) => String(e)).filter((e) => e.length > 0);
        }
      } catch {
        // fall through: treat the whole string as one evidence item
      }
    }
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return [];
}

/** Friendly evaluator name: strip the Builtin. prefix and the deploy-specific analyst prefix. */
function evaluatorLabel(name: string): string {
  if (name.startsWith("Builtin.")) return name.slice("Builtin.".length);
  if (name.includes("analyst_agreement")) return "Analyst Agreement";
  return name;
}

/**
 * One evaluator row: score/label always visible, full reasoning expandable on click.
 * Collapsed by default; the caret + a one-line reasoning preview signal there is more.
 */
function EvalRow({ record }: { record: CaseEvalRecord }) {
  const [open, setOpen] = useState(false);
  const score =
    record.value !== null && record.value !== "" ? Number(record.value) : null;
  const failed = Boolean(record.error);
  const abstained = !failed && score === null;
  const badgeColor = failed
    ? "var(--rc-red)"
    : abstained
      ? "var(--rc-ink-faint)"
      : score !== null && score >= 0.5
        ? "var(--rc-green)"
        : "var(--rc-red)";
  const reasoning = failed
    ? `Evaluator failed: ${record.error}`
    : (record.explanation ?? "No explanation recorded.");

  return (
    <li className="py-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 text-left"
      >
        <span
          className="rc-mono min-w-[3.5rem] rounded border px-1.5 py-0.5 text-center text-[11px]"
          style={{ borderColor: badgeColor, color: badgeColor }}
        >
          {failed ? "ERROR" : score !== null ? score.toFixed(1) : "—"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--rc-ink)]">
          {evaluatorLabel(record.evaluator)}
          {record.label && (
            <span className="rc-mono ml-2 text-[11px] text-[var(--rc-ink-dim)]">
              {record.label}
            </span>
          )}
        </span>
        <span
          className="rc-mono select-none text-[11px] text-[var(--rc-ink-faint)]"
          aria-hidden
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? (
        <p className="mt-2 whitespace-pre-wrap break-words pl-[calc(3.5rem+0.75rem)] text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
          {reasoning}
        </p>
      ) : (
        <p className="mt-1 truncate pl-[calc(3.5rem+0.75rem)] text-[12px] text-[var(--rc-ink-faint)]">
          {reasoning}
        </p>
      )}
    </li>
  );
}

/**
 * Latest evaluation run for this case (AgentCore online/batch evaluations), rendered under
 * the Proposed Resolution panel. Loads independently of the case row — eval records live in
 * CloudWatch, not DynamoDB — and re-fetches when the case status changes (an approve/reject
 * kicks an async re-score whose result lands a few minutes later).
 */
function CaseEvalPanel({
  caseId,
  status,
}: {
  caseId: string;
  status?: string;
}) {
  const [evals, setEvals] = useState<CaseEvals | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getCaseEvals(caseId)
      .then((d) => alive && setEvals(d))
      .catch(() => alive && setEvals(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [caseId, status]);

  const records = evals?.records ?? [];
  return (
    <Panel className="rc-rise p-6">
      <div className="flex items-center justify-between gap-3">
        <Eyebrow title="How AgentCore Evaluations scored this case's latest agent session: LLM judges (correctness, goal success, helpfulness) plus the ground-truth analyst-agreement evaluator. Re-scored automatically when you approve or correct. Click a row to expand its full reasoning.">
          Evaluation
        </Eyebrow>
        {evals?.session && (
          <span
            className="rc-mono min-w-0 truncate text-[11px] text-[var(--rc-ink-faint)]"
            title={`Evaluated agent session (latest run for this case): ${evals.session}`}
          >
            {evals.session}
          </span>
        )}
      </div>

      {loading ? (
        <p className="rc-mono mt-4 text-[12px] text-[var(--rc-ink-faint)]">
          Loading evaluation…
        </p>
      ) : records.length === 0 ? (
        <p className="rc-mono mt-4 text-[12px] text-[var(--rc-ink-faint)]">
          No evaluation recorded for this case yet — the online evaluator scores
          each agent session a few minutes after it completes.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--rc-line-soft)]">
          {records.map((r) => (
            <EvalRow key={r.evaluator} record={r} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function CaseDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [recon, setRecon] = useState<ReconCase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [disapproving, setDisapproving] = useState(false);
  const [comment, setComment] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  // Something the analyst must know that is NOT a failure — currently only a resolved case whose
  // internal notification mail did not go out. Kept separate from actionError so a closed case is
  // never painted red, which would read as "retry this".
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  // Decision-comment requirement mode (Config tab): required | optional | disapprove-only.
  const [commentMode, setCommentMode] = useState<string>("disapprove-only");
  // Counterparty domains an analyst may address a draft to. Deploy-time configuration, fetched with
  // the rest of the platform config; empty until it arrives, which is also the fail-safe value.
  const [emailDomains, setEmailDomains] = useState<string[]>([]);
  // Explicit human override for a draft whose earlier send outcome is unknown. Deliberately not
  // sticky across reloads — it is a statement about one attempt, made after checking Sent Items.
  const [overrideUnknownSend, setOverrideUnknownSend] = useState(false);

  const reload = () =>
    getCase(id, getStoredAccessToken())
      .then(setRecon)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    reload();
    getConfig()
      .then((c) => {
        if (c.commentRequirement) setCommentMode(c.commentRequirement);
        setEmailDomains(c.counterpartyEmailDomains ?? []);
      })
      .catch(() => {
        /* default mode stands */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (error)
    return (
      <Placeholder kind="error">Failed to load case — {error}</Placeholder>
    );
  if (!recon)
    return <Placeholder kind="loading">◆ loading case {id}…</Placeholder>;

  // The counterparty email draft, when the agent proposed writing to anyone.
  const draft = recon.proposed_email ?? null;
  // A draft still awaiting a decision blocks the case decision: RESOLVED is terminal, so approving
  // now would leave the draft permanently unsendable on a case that reads as successfully closed.
  const draftBlocksApproval = draft?.draft_status === "pending";

  const retry = async () => {
    setBusy("retry");
    setActionError(null);
    try {
      await retryCase(id);
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    setBusy("cancel");
    setActionError(null);
    try {
      await cancelCase(id, comment.trim() || undefined);
      setComment("");
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const approve = async () => {
    if (commentMode === "required" && !comment.trim()) {
      setActionError("A comment is required by configuration to approve.");
      return;
    }
    setBusy("approve");
    setActionError(null);
    try {
      // An approved draft turns this into a send. The revision goes with it so the BFF can refuse
      // an approval aimed at text that has since changed, rather than mailing the newer text.
      const result = await approveCase(
        id,
        comment.trim() || undefined,
        draft?.draft_status === "approved"
          ? { revision: draft.revision, overrideUnknownSend }
          : undefined,
      );
      setComment("");
      setOverrideUnknownSend(false);
      // The case resolved; only the internal courtesy mail failed. Say so as a notice rather than
      // an error, because treating it as a failed approval would invite a retry that cannot work —
      // the case is already terminal.
      setActionNotice(
        result.notification_error
          ? `Case resolved, but the resolution notification could not be sent: ${result.notification_error}`
          : null,
      );
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  // --- counterparty draft -------------------------------------------------------------------
  // Both handlers reload afterwards: the stored revision is what every subsequent action is pinned
  // to, so the panel must never keep showing a revision the row has moved past.
  const saveDraft = async (fields: {
    recipient: string;
    subject: string;
    body: string;
    revision: number;
  }) => {
    setBusy("draft");
    setActionError(null);
    try {
      await saveEmailDraft(id, fields);
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const decideDraft = async (
    action: "approve_draft" | "revoke_draft" | "discard_draft",
    revision: number,
  ) => {
    setBusy("draft");
    setActionError(null);
    try {
      await decideEmailDraft(id, action, revision);
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const disapprove = async (outcome: "no_action" | "reprocess") => {
    if (commentMode !== "optional" && !comment.trim()) {
      setActionError("A correction comment is required to disapprove.");
      return;
    }
    setBusy(outcome);
    setActionError(null);
    try {
      await rejectCase(id, comment.trim(), outcome);
      setDisapproving(false);
      setComment("");
      await reload();
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const steps = recon.steps ?? [];
  const idp = recon.item?.attributes;

  // IDP Assessment classification confidence (0..1), when the pipeline emits it.
  const idpClsConf =
    idp?.idp_classification_confidence != null
      ? String(idp.idp_classification_confidence)
      : null;
  // One-line summary of the investigation: step count + the distinct tools invoked.
  const toolsUsed = Array.from(
    new Set(
      steps
        .filter((s) => s.kind === "tool_call" && s.tool)
        .map((s) => s.tool as string),
    ),
  );
  const stepSummary =
    steps.length === 0
      ? "No steps recorded."
      : `${steps.length} step${steps.length === 1 ? "" : "s"}` +
        (toolsUsed.length ? ` · tools: ${toolsUsed.join(", ")}` : "");

  // Human labels + tooltips per trace-entry kind.
  const KIND_META: Record<string, { label: string; tip: string }> = {
    lesson_recall: {
      label: "Recall lessons",
      tip: "Retrieved prior analyst decisions on similar items from AgentCore Memory (advisory).",
    },
    classify: {
      label: "Classify",
      tip: "Chose the reconciliation skill via self-consistency sampling.",
    },
    skill_load: {
      label: "Skill",
      tip: "Ran a matched investigation skill (its SKILL.md procedure).",
    },
    tool_call: {
      label: "Tool call",
      tip: "Invoked a Gateway tool and recorded its result.",
    },
    execute: {
      label: "Execute",
      tip: "Performed the resolution write against the system of record.",
    },
    propose: {
      label: "Propose",
      tip: "Synthesized the proposed resolution from the findings.",
    },
  };
  const kindMeta = (k?: string) =>
    (k && KIND_META[k]) || { label: "Step", tip: "An investigation step." };

  return (
    <div className="space-y-6">
      {/* breadcrumb + header */}
      <div className="flex items-center justify-between">
        <Link
          href="/recon/queue"
          className="rc-mono text-[12px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] transition-colors hover:text-[var(--rc-ink)]"
        >
          ← Queue
        </Link>
        <StatusPill status={recon.status} />
      </div>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>Case</Eyebrow>
          <h1 className="rc-mono mt-2 text-[30px] font-medium leading-none text-[var(--rc-ink)]">
            {recon.item_id}
          </h1>
        </div>
        {recon.status === "IN_PROGRESS" && (
          <div className="flex gap-3">
            <button
              onClick={retry}
              disabled={busy !== null}
              title="Re-drive the investigation through the agent worker (backend switch honored)"
              className="rc-mono rounded border border-[var(--rc-green)] px-5 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-green)] transition-colors hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40"
            >
              {busy === "retry" ? "Retrying…" : "Retry / Re-process"}
            </button>
            <button
              onClick={cancel}
              disabled={busy !== null}
              title="Close this stuck case as CLOSED_NO_ACTION (terminal, audited)"
              className="rc-mono rounded border border-[var(--rc-red)] px-5 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-red)] transition-colors hover:bg-[var(--rc-red)] hover:text-[#120404] disabled:opacity-40"
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel case"}
            </button>
          </div>
        )}
        {recon.status === "PROPOSED" && !disapproving && (
          <div className="flex gap-3">
            <button
              onClick={approve}
              disabled={busy !== null || draftBlocksApproval}
              title={
                draftBlocksApproval
                  ? "This case has a counterparty email draft awaiting a decision — approve or discard the draft first"
                  : draft?.draft_status === "approved"
                    ? "Approving also sends the approved counterparty email"
                    : undefined
              }
              className="rc-mono rounded border border-[var(--rc-green)] px-5 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-green)] transition-colors hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40"
            >
              {busy === "approve"
                ? "Approving…"
                : draft?.draft_status === "approved"
                  ? "Approve & send"
                  : "Approve"}
            </button>
            <button
              onClick={() => {
                setDisapproving(true);
                setActionError(null);
              }}
              disabled={busy !== null}
              className="rc-mono rounded border border-[var(--rc-red)] px-5 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-red)] transition-colors hover:bg-[var(--rc-red)] hover:text-[#120404] disabled:opacity-40"
            >
              Disapprove
            </button>
          </div>
        )}
      </header>

      {recon.status === "PROPOSED" && !disapproving && (
        <div>
          <label className="rc-eyebrow mb-2 block">
            {commentMode === "required"
              ? "Comment (required — attached to your decision)"
              : "Comment (optional — attached to your approval)"}
          </label>
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a note for the record…"
            className="rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[13px] text-[var(--rc-ink)]"
          />
        </div>
      )}

      {actionError && (
        <p className="rc-mono text-[12px] text-[var(--rc-red)]">
          {actionError}
        </p>
      )}

      {actionNotice && (
        <p className="rc-mono text-[12px] text-[var(--rc-amber)]">
          {actionNotice}
        </p>
      )}

      {recon.status === "PROPOSED" && disapproving && (
        <Panel className="rc-rise p-5">
          <Eyebrow>
            {commentMode === "optional"
              ? "Disapprove — correction optional"
              : "Disapprove — correction required"}
          </Eyebrow>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Why is the recommendation wrong? Your correction is captured as a lesson and, on re-process, fed back to the agent."
            className="rc-mono mt-3 h-28 w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 text-[13px] text-[var(--rc-ink)]"
          />
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              onClick={() => disapprove("no_action")}
              disabled={busy !== null}
              className="rc-mono rounded border border-[var(--rc-ink-faint)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)] disabled:opacity-40"
            >
              {busy === "no_action" ? "Closing…" : "No further action required"}
            </button>
            <button
              onClick={() => disapprove("reprocess")}
              disabled={busy !== null}
              className="rc-mono rounded border border-[var(--rc-violet)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-violet)] hover:bg-[var(--rc-violet)] hover:text-[#0a0410] disabled:opacity-40"
            >
              {busy === "reprocess"
                ? "Re-processing…"
                : "Re-process with my comment"}
            </button>
            <button
              onClick={() => {
                setDisapproving(false);
                setActionError(null);
              }}
              disabled={busy !== null}
              className="rc-mono px-2 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
            >
              Cancel
            </button>
          </div>
        </Panel>
      )}

      {/* The counterparty email, above the document panel: it is the one thing on this page that
          can leave the operator, and it is the analyst's decision to make. */}
      {draft && (
        <EmailDraftPanel
          draft={draft}
          caseStatus={recon.status}
          allowedDomains={emailDomains}
          busy={busy !== null}
          overrideUnknownSend={overrideUnknownSend}
          onOverrideChange={setOverrideUnknownSend}
          onSave={saveDraft}
          onDecide={decideDraft}
        />
      )}

      {/* IDP document processing: classification + extracted fields (embedded at ingest). */}
      {idp && <IdpDocumentPanel idp={idp} />}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.4fr]">
        {/* Classification + proposed resolution. min-w-0: grid tracks default to
            min-width:auto, so a long unbroken line would blow the column out and push the
            Agent Trace column off-screen (horizontal scrollbar) instead of wrapping. */}
        <div className="min-w-0 space-y-6">
          <Panel className="rc-rise p-6" scan>
            <Eyebrow title="The document/package classification assigned by the IDP pipeline (what kind of document this is).">
              Document / Package Classification
            </Eyebrow>
            <div className="rc-display mt-3 text-[22px] font-bold text-[var(--rc-cyan)]">
              {idp?.idp_class ?? recon.class_id ?? "—"}
            </div>
            {idpClsConf != null && (
              <div
                className="mt-4"
                title="IDP Assessment confidence: the document-classification confidence reported by the IDP pipeline's Assessment Inference step."
              >
                <ConfidenceMeter value={idpClsConf} />
              </div>
            )}
            {/* How recon reconciled it: the matched skill + a summary of the steps taken. */}
            <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
              <div
                className="rc-eyebrow mb-1"
                title="The reconciliation skill the recon agent matched to investigate this document (distinct from the IDP document class above)."
              >
                Matched skill
              </div>
              <div className="rc-mono text-[13px] text-[var(--rc-ink)]">
                {recon.class_id ?? "—"}
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                {recon.classification_reasoning ?? "No reasoning recorded."}
              </p>
              <div
                className="rc-mono mt-3 text-[11px] text-[var(--rc-ink-faint)]"
                title="Steps the agent took to reconcile, and which Gateway tools it invoked."
              >
                {stepSummary}
              </div>
            </div>
          </Panel>

          <Panel className="rc-rise p-6">
            <Eyebrow title="The resolution the agent proposes. When Overall Confidence clears the auto-resolve threshold the agent executes it autonomously; otherwise it awaits your approval.">
              Proposed Resolution
            </Eyebrow>
            <p className="mt-3 text-[15px] leading-relaxed text-[var(--rc-ink)]">
              {recon.resolution ?? "—"}
            </p>
            {recon.confidence && (
              <div
                className="mt-5 border-t border-[var(--rc-line-soft)] pt-4"
                title="Computed composite: 0.45 × classification self-consistency + 0.35 × evidence grounding + 0.20 × model self-report (−10% if IDP flagged low-confidence fields). Drives the auto-resolve threshold."
              >
                <div className="rc-eyebrow mb-2">
                  Overall Confidence{" "}
                  {recon.confidence_components
                    ? "(computed)"
                    : "(agent-stated)"}
                </div>
                <ConfidenceMeter value={recon.confidence} />
                {recon.confidence_components && (
                  <div
                    className="rc-mono mt-3 space-y-1 text-[11px] text-[var(--rc-ink-faint)]"
                    title="consistency = agreement across 3 independent classification samples · grounding = fraction of cited evidence values that literally appear in the item data · self-report = the model's verbalized confidence (weak signal)."
                  >
                    <div>
                      consistency{" "}
                      {Number(
                        recon.confidence_components.consistency ?? 0,
                      ).toFixed(2)}{" "}
                      · grounding{" "}
                      {Number(
                        recon.confidence_components.grounding ?? 0,
                      ).toFixed(2)}{" "}
                      · self-report{" "}
                      {Number(
                        recon.confidence_components.verbalized ?? 0,
                      ).toFixed(2)}
                    </div>
                    {Number(recon.confidence_components.idp_alerts ?? 0) >
                      0 && (
                      <div style={{ color: "var(--rc-amber)" }}>
                        −10% penalty:{" "}
                        {String(recon.confidence_components.idp_alerts)}{" "}
                        low-confidence IDP field(s)
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </Panel>

          {/* Latest AgentCore evaluation — left column, directly under Proposed Resolution. */}
          <CaseEvalPanel caseId={id} status={recon?.status} />
        </div>

        {/* Agent trace: the actual steps the agent took — right column. min-w-0 so its own
            long tool-output lines wrap within the track rather than widening the grid. */}
        <Panel className="rc-rise min-w-0 p-6">
          <div className="flex items-center justify-between">
            <Eyebrow title="The steps the agent actually took: recall → classify → run skill(s) → tool calls → propose → (execute when auto-actioned). No per-step confidence — see the composite Overall Confidence.">
              Agent Trace
            </Eyebrow>
            <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              {steps.length} step{steps.length === 1 ? "" : "s"}
            </span>
          </div>

          {steps.length === 0 ? (
            <p className="rc-mono mt-4 text-[12px] text-[var(--rc-ink-faint)]">
              No investigation steps recorded.
            </p>
          ) : (
            <ol className="mt-5 space-y-0">
              {steps.map((s, i) => {
                const meta = kindMeta(s.kind);
                const failed =
                  s.kind === "execute" && s.outcome?.startsWith("failed");
                const dot =
                  s.kind === "execute"
                    ? failed
                      ? "var(--rc-red)"
                      : "var(--rc-green)"
                    : "var(--rc-cyan)";
                return (
                  <li key={i} className="relative pb-6 pl-6 last:pb-0">
                    {/* timeline rail */}
                    <span
                      className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full"
                      style={{ background: dot, boxShadow: `0 0 6px ${dot}` }}
                    />
                    {i < steps.length - 1 && (
                      <span className="absolute left-[4.5px] top-4 h-full w-px bg-[var(--rc-line)]" />
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="rc-mono rounded border border-[var(--rc-line)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)]"
                        title={meta.tip}
                      >
                        {meta.label}
                      </span>
                      <span className="rc-mono text-[13px] font-medium text-[var(--rc-ink)]">
                        {/* propose step's skill IS the chosen class; "unknown" means the
                            classifier fell below threshold / off-catalog — say so plainly
                            instead of surfacing a bare "unknown" that reads like a glitch. */}
                        {s.kind === "propose" && s.skill === "unknown"
                          ? "Unclassified"
                          : s.skill}
                      </span>
                      {s.ts && (
                        <span
                          className="rc-mono text-[11px] text-[var(--rc-ink-faint)]"
                          title="When this step was recorded (UTC)"
                        >
                          {new Date(s.ts).toLocaleString()}
                        </span>
                      )}
                      {s.kind === "execute" && s.outcome && (
                        <span
                          className="rc-mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
                          style={{
                            border: `1px solid ${failed ? "var(--rc-red)" : "var(--rc-green)"}`,
                            color: failed ? "var(--rc-red)" : "var(--rc-green)",
                          }}
                          title="Whether the resolution write actually executed."
                        >
                          {failed ? "Failed" : "Executed"}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                      {s.reasoning}
                    </p>
                    {/* tool_call: show the invocation and its result. */}
                    {s.kind === "tool_call" && (
                      <div className="rc-mono mt-2 rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-2 text-[11px] text-[var(--rc-ink-faint)]">
                        <div className="text-[var(--rc-ink-dim)]">
                          {s.tool}({JSON.stringify(s.tool_input ?? {})})
                        </div>
                        {s.tool_output && (
                          <div className="mt-1 break-all">
                            → {s.tool_output}
                          </div>
                        )}
                      </div>
                    )}
                    {/* execute: show the structured action performed. */}
                    {s.kind === "execute" && s.action && (
                      <div className="rc-mono mt-2 break-all rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-2 text-[11px] text-[var(--rc-ink-faint)]">
                        {JSON.stringify(s.action)}
                      </div>
                    )}
                    {normalizeEvidence(s.evidence).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {normalizeEvidence(s.evidence).map((e, j) => (
                          <span
                            key={j}
                            className="rc-mono rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-2 py-1 text-[11px] text-[var(--rc-ink-faint)]"
                          >
                            {e}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}

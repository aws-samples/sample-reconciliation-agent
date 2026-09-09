"use client";

import { Fragment, use, useEffect, useState } from "react";
import Link from "next/link";
import {
  approveCase,
  decideEmailDraft,
  getCase,
  getCaseEvals,
  getConfig,
  listContactSummaries,
  rejectCase,
  saveEmailDraft,
  type CaseEvals,
  type CaseEvalRecord,
  type ContactSummary,
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
import { MatchedNoticesPanel } from "@/components/recon/MatchedNoticesPanel";
import { Tier1RoutingPanel } from "@/components/recon/Tier1RoutingPanel";
import { Tier1ResolutionPanel } from "@/components/recon/Tier1ResolutionPanel";
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
 * Latest evaluation run for this case (AgentCore online/batch evaluations), the last section on
 * the page. Loads independently of the case row — eval records live in
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
  // The fetch error, kept rather than swallowed. It used to be discarded into `setEvals(null)`, which
  // rendered the same "no evaluation recorded yet" line as a successful empty response — so a 403, a
  // failed evaluator lookup and a case that genuinely has not been scored yet were three different
  // problems wearing one message, and the panel looked permanently empty with no way to tell why.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    getCaseEvals(caseId)
      .then((d) => {
        if (alive) setEvals(d);
      })
      .catch((e) => {
        if (alive) {
          setEvals(null);
          setLoadError(String(e));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
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
      ) : loadError ? (
        <p
          className="rc-mono mt-4 break-words text-[12px]"
          style={{ color: "var(--rc-amber)" }}
          title="The evaluation lookup itself failed. This is not the same as a case that has not been scored yet."
        >
          Could not load the evaluation — {loadError}
        </p>
      ) : records.length === 0 ? (
        <div className="mt-4 space-y-2">
          <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            No evaluation recorded for this case yet — the online evaluator
            scores each agent session a few minutes after it completes.
          </p>
          {/* Which session was searched, when there was one. An empty result against a known session
              means the evaluator has not run yet; an empty result with no session at all means the
              case's agent invocation was never matched to a session, which is a different fault and
              was previously indistinguishable. */}
          <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            {evals?.session
              ? `Searched session ${evals.session} — no evaluator records found against it.`
              : "No agent session is associated with this case, so there is nothing to evaluate against."}
          </p>
        </div>
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
  // The counterparty contacts an analyst may address a draft to, from the operator's list. Names and
  // ids only — no addresses reach this page. Empty until it arrives, which is also the fail-safe
  // value: the panel then offers no recipient rather than a free-text field.
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
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
      })
      .catch(() => {
        /* default mode stands */
      });
    // Only counterparty contacts: this page's draft is a counterparty email, and offering an internal
    // notification contact would produce a selection the send path refuses on kind.
    listContactSummaries("counterparty")
      .then(setContacts)
      .catch(() => {
        /* no recipients offered — the panel says so rather than showing an empty dropdown */
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
    recipient_contact_id: string;
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
  const components = recon.confidence_components;

  // Whether the deterministic tier resolved this case, in which case none of the agent panels below
  // apply and all of them are suppressed in favour of Tier1ResolutionPanel.
  //
  // Gated on `tier`, deliberately, and NEVER on the agent fields being empty. A Tier-2 case whose
  // agent produced no trace and no proposal looks identical here, and for that case the emptiness IS
  // the finding an analyst needs to see. `tier` is the only thing that separates "no agent ran" from
  // "the agent ran and came back with nothing".
  const isTier1Resolved = recon.tier === 1 && !!recon.category;

  // One row per evidence step, ordered as the agent reported them, then the required steps it never
  // reported at all. Two sources are needed because the two facts live in different places: the
  // agent's per-step note is only on the trace entry, while a step that produced NO trace entry
  // exists only as an id in `unattempted_step_ids`. Reading the trace alone would silently drop the
  // steps whose absence is exactly what dragged the score down.
  const EVIDENCE_RESULT = {
    satisfied: {
      label: "Satisfied",
      color: "var(--rc-cyan)",
      tip: "The step's tool call returned data answering it. Counts toward the Evidence Score.",
    },
    empty: {
      label: "Returned nothing",
      color: "var(--rc-amber)",
      tip: "The agent ran this step and the data was not there. Scores zero, but it is a finding about the records rather than about the investigation.",
    },
    unattempted: {
      label: "Not attempted",
      color: "var(--rc-amber)",
      tip: "No data was obtained and the agent did not report trying. Scores zero.",
    },
  } as const;
  const reportedRows = steps
    .filter((s) => s.kind === "evidence_step" && s.step_id)
    .map((s) => {
      const outcome =
        s.satisfied === true
          ? EVIDENCE_RESULT.satisfied
          : s.satisfied === false
            ? EVIDENCE_RESULT.empty
            : EVIDENCE_RESULT.unattempted;
      return {
        stepId: s.step_id as string,
        note: s.reasoning || "No note recorded.",
        ...outcome,
      };
    });
  const reportedIds = new Set(reportedRows.map((r) => r.stepId));
  const evidenceRows = [
    ...reportedRows,
    ...(components?.unattempted_step_ids ?? [])
      .filter((sid) => !reportedIds.has(sid))
      .map((sid) => ({
        stepId: sid,
        note: "The agent never reported on this step.",
        ...EVIDENCE_RESULT.unattempted,
      })),
  ];

  // The skill the investigation ran under. One per case by construction: the agent classifies into
  // a single break type, and that skill's declared steps are the denominator of the score above.
  // `components.skill` and `class_id` are written from the same value; prefer the scored one.
  //
  // The panel deliberately shows only this one. The rest of the catalog is loaded into every
  // prompt, so listing it told the analyst nothing about THIS case: the same six names appeared on
  // every case, and the trace records no work against any of them.
  const drivingSkill = components?.skill ?? recon.class_id ?? null;
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
      label: "Skill loaded",
      // Availability, not execution: the backend records one of these per skill it puts in the
      // prompt, before the agent has classified anything. Only the classified skill named in the
      // Skills field above was actually investigated against.
      tip: "An investigation skill (its SKILL.md procedure) was loaded into the prompt and made available to the agent. Not evidence that it ran.",
    },
    tool_call: {
      label: "Tool call",
      tip: "Invoked a Gateway tool and recorded its result.",
    },
    execute: {
      label: "Execute",
      tip: "Performed the resolution write against the system of record.",
    },
    evidence_step: {
      label: "Evidence",
      tip: "The agent's report on one evidence step its skill prescribes: whether that step's tool call actually returned data. These reports are what the Evidence Score counts.",
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
        {/* The same two actions serve both states an analyst can unstick: IN_PROGRESS (looks stuck,
            nothing proved it died) and FAILED (the worker proved it died). Retry re-drives either;
            Cancel closes either terminally. */}
        {(recon.status === "IN_PROGRESS" || recon.status === "FAILED") && (
          <div className="flex gap-3">
            <button
              onClick={retry}
              disabled={busy !== null}
              title={
                recon.status === "FAILED"
                  ? "Re-open this failed case and re-drive the investigation through the agent worker"
                  : "Re-drive the investigation through the agent worker (backend switch honored)"
              }
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

      {/* Gated on the status, not on `failure_reason` being present: a retry moves the case back to
          IN_PROGRESS and leaves the reason on the row, so keying off the field would keep showing a
          stale post-mortem over a live investigation. */}
      {recon.status === "FAILED" && (
        <Panel className="rc-rise border-[var(--rc-red)] p-5">
          <Eyebrow>Investigation failed</Eyebrow>
          <p className="rc-mono mt-3 text-[13px] leading-relaxed text-[var(--rc-ink)]">
            {recon.failure_reason ??
              "The run errored out and no reason was recorded."}
          </p>
          <p className="rc-mono mt-3 text-[12px] text-[var(--rc-ink-faint)]">
            {recon.failed_at ? `Failed at ${recon.failed_at} UTC. ` : ""}
            No proposal was produced. Retry re-runs the investigation from the
            item as stored; cancel closes the case with no action.
          </p>
        </Panel>
      )}

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
          contacts={contacts}
          busy={busy !== null}
          overrideUnknownSend={overrideUnknownSend}
          onOverrideChange={setOverrideUnknownSend}
          onSave={saveDraft}
          onDecide={decideDraft}
        />
      )}

      {/* IDP document processing: classification + extracted fields (embedded at ingest). */}
      {idp && <IdpDocumentPanel idp={idp} />}

      {/* One column, full width, read top to bottom: score and what the agent proposes → the
          evidence that produced the score → what Tier-1 had concluded before the agent ran → the
          trace → the evaluation.

          This was a two-column grid with the Agent Trace pinned beside everything else until
          2026-09-03. The trace is the widest thing on the page — raw tool inputs and outputs —
          and squeezing it into 58% of the width meant every line wrapped, while the evidence
          table on the left wrapped its "what was found" column into a ribbon three words wide.
          Reading either one meant scrolling past the other. Neither is glanced at; both are read.
          min-w-0 stays on the wide panels so a long unbroken tool-output line still wraps rather
          than widening the page into a horizontal scrollbar. */}
      <div className="space-y-6">
        {/* 0. How the deterministic tier cleared this case. Leads the page and REPLACES every agent
              panel below, rather than sitting above a column of empty ones. An empty panel reads as
              "something failed to produce this", which on a straight-through auto-clear is both
              wrong and the opposite of the point — and the proposed-action panel used to say
              outright that the case escalated for a human decision. */}
        {isTier1Resolved && (
          <Tier1ResolutionPanel
            match={recon.tier1_match}
            category={recon.category}
          />
        )}

        {/* 1. The score, and what the agent wants to do about it. The number decides whether this
              case can clear without a human, so it leads; the proposed step and the agent's own
              account sit under it because they are the answer to "and therefore what?" — they
              were a separate panel below the evidence table until 2026-09-03, which put the
              table between the score and its consequence. */}
        {!isTier1Resolved && (
          <>
            <Panel className="rc-rise min-w-0 p-6" scan>
              <Eyebrow title="Evidence completeness: the fraction of the matched skill's required investigation steps that returned data answering them. This is the number the auto-resolve threshold compares against. It measures how COMPLETE the evidence is, never whether the answer is right.">
                Evidence Score
              </Eyebrow>
              {recon.confidence == null ? (
                <div className="rc-display mt-3 text-[34px] font-bold text-[var(--rc-ink-faint)]">
                  —
                </div>
              ) : (
                <>
                  <div className="mt-3 flex items-baseline gap-3">
                    <span className="rc-display text-[34px] font-bold leading-none text-[var(--rc-cyan)]">
                      {(Number(recon.confidence) * 100).toFixed(0)}%
                    </span>
                    {!components?.unscoreable && (
                      <span className="rc-mono text-[13px] text-[var(--rc-ink-dim)]">
                        {components?.satisfied ?? 0} of{" "}
                        {components?.prescribed ?? 0} required evidence steps
                        satisfied
                      </span>
                    )}
                  </div>
                  <div className="mt-4">
                    <ConfidenceMeter value={recon.confidence} />
                  </div>
                </>
              )}
              {components && (
                <div className="rc-mono mt-3 space-y-1 text-[11px] text-[var(--rc-ink-faint)]">
                  {components.unscoreable ? (
                    <div style={{ color: "var(--rc-amber)" }}>
                      {components.unscoreable} — no evidence was prescribed, so
                      this case cannot auto-resolve
                    </div>
                  ) : null}
                  {(components.unsatisfied_step_ids ?? []).length > 0 && (
                    <div style={{ color: "var(--rc-amber)" }}>
                      returned nothing:{" "}
                      {components.unsatisfied_step_ids?.join(", ")}
                    </div>
                  )}
                  {(components.unattempted_step_ids ?? []).length > 0 && (
                    <div style={{ color: "var(--rc-amber)" }}>
                      not attempted:{" "}
                      {components.unattempted_step_ids?.join(", ")}
                    </div>
                  )}
                  {/* A reported id the skill never declared. Shown because it is the one entry
                    here that reports a defect in the AGENT's reporting rather than in the
                    evidence: the step it was meant to report shows up as "not attempted"
                    above, and without this line that looks like the agent skipped work it
                    actually did. */}
                  {(components.undeclared_step_ids ?? []).length > 0 && (
                    <div
                      style={{ color: "var(--rc-amber)" }}
                      title="The agent reported an evidence step this skill does not declare, so it was ignored for scoring. Usually means it renamed a prescribed step — compare with 'not attempted' above."
                    >
                      reported but not prescribed (ignored):{" "}
                      {components.undeclared_step_ids?.join(", ")}
                    </div>
                  )}
                </div>
              )}

              {/* Context for the score: which skill's step list the fraction above is measured
                against, and what else the agent had in front of it when it chose.

                The IDP document class used to sit here as well. It is the document pipeline's
                classification, it is already surfaced on the IDP panel above (with that
                pipeline's own extraction-confidence alert count — a different quantity from
                this score, produced by a different system), and printing it directly beside
                the recon skill invited reading the two as one field. */}
              <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
                {/* The label carries the whole sentence, so the value beside it needs no trailing
                  qualifier. The agent classifies each case into exactly ONE break type and
                  investigates against that skill's procedure, and that skill's declared evidence
                  steps are the denominator of the Evidence Score above — which is what "drove the
                  score" means here. */}
                <div
                  className="rc-eyebrow mb-1"
                  title="The reconciliation skill this investigation ran under. Its declared evidence steps are the denominator of the Evidence Score above. Not the IDP document class — that is the document pipeline's own classification, on the panel above."
                >
                  Skill that drove the score
                </div>
                <div className="rc-mono text-[13px] text-[var(--rc-ink)]">
                  {/* The classification rationale is a tooltip rather than a paragraph. It used to be
                    rendered here in full, directly above the agent's final narrative, and two
                    paragraphs of agent prose stacked on one panel read as one continuous account
                    when they are answers to different questions ("why this skill?" versus "what
                    should happen?"). It is one line of context about a single field, so it belongs
                    on that field. */}
                  <span
                    title={
                      recon.classification_reasoning
                        ? `Why this skill: ${recon.classification_reasoning}`
                        : "No classification reasoning was recorded."
                    }
                  >
                    {drivingSkill ?? "—"}
                  </span>
                </div>
                <div
                  className="rc-mono mt-2 text-[11px] text-[var(--rc-ink-faint)]"
                  title="Steps the agent took to reconcile, and which Gateway tools it invoked."
                >
                  {stepSummary}
                </div>
              </div>

              {/* The proposed next step. Rendered from the STRUCTURED action when the agent produced
                one, because that is the thing that would actually execute; the prose is the agent's
                account of it and can describe a step the action does not contain. */}
              <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
                <div
                  className="rc-eyebrow mb-2"
                  title="The executable step the agent proposes. Absent when the investigation found nothing safely actionable — such a case always escalates to a human regardless of its score."
                >
                  Proposed next step
                </div>
                {recon.proposed_action ? (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
                    {Object.entries(recon.proposed_action).map(([k, v]) => (
                      <Fragment key={k}>
                        <dt className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                          {k}
                        </dt>
                        <dd className="rc-mono break-words text-[12px] text-[var(--rc-ink)]">
                          {typeof v === "object" && v !== null
                            ? JSON.stringify(v)
                            : String(v)}
                        </dd>
                      </Fragment>
                    ))}
                  </dl>
                ) : (
                  <p className="rc-mono text-[12px] text-[var(--rc-amber)]">
                    No executable action was proposed — this case escalates for
                    a human decision.
                  </p>
                )}
              </div>

              {/* The agent's own account, kept but demoted. It carries reasoning the structured
                fields above cannot, and it is the wrong thing to lead with.

                This is the ONLY agent prose on the panel, deliberately. It is the `resolution` the
                agent submitted with its proposal — the same string the trace's final `propose`
                entry carries — so it is the account of the conclusion, written after the
                investigation. Nothing else on this panel should be a paragraph. */}
              <div className="mt-5 border-t border-[var(--rc-line-soft)] pt-4">
                <div
                  className="rc-eyebrow mb-2"
                  title="The agent's final account of the case, as submitted with its proposal. Not the classification rationale — that is a tooltip on the skill above."
                >
                  Agent&apos;s narrative
                </div>
                <p className="text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                  {recon.resolution ?? "—"}
                </p>
              </div>
            </Panel>

            {/* 2. Where the score came from. Its own section now that it has the full width: the
              "what was found" column is a sentence per row, and it was the thing the old
              two-column layout squeezed hardest.

              This table replaced a single paragraph of the agent's prose: the paragraph said what
              the agent concluded but not which prescribed step each finding answered, so there
              was no way to see WHY the score was what it was without reading the whole trace. */}
            <Panel className="rc-rise min-w-0 p-6">
              <Eyebrow title="One row per evidence step the matched skill prescribes, and what the agent's tool calls actually returned for it. The satisfied fraction of these rows IS the Evidence Score above.">
                Evidence Behind the Score
              </Eyebrow>

              <div className="mt-4">
                {evidenceRows.length === 0 ? (
                  <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                    No evidence steps were reported for this case.
                  </p>
                ) : (
                  <div className="overflow-hidden rounded border border-[var(--rc-line-soft)]">
                    <table className="w-full table-fixed border-collapse text-left">
                      <thead>
                        {/* Re-weighted for the full-width layout. The step id is a short mono token and
                        the result is one word; at the old 38/22 split they held mostly whitespace
                        while the finding — the only column with a sentence in it — wrapped into a
                        narrow ribbon. */}
                        <tr className="bg-[var(--rc-line-soft)]/40">
                          <th className="rc-eyebrow w-[20%] px-3 py-2">Step</th>
                          <th className="rc-eyebrow w-[12%] px-3 py-2">
                            Result
                          </th>
                          <th className="rc-eyebrow px-3 py-2">
                            What was found
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {evidenceRows.map((row) => (
                          <tr
                            key={row.stepId}
                            className="border-t border-[var(--rc-line-soft)] align-top"
                          >
                            <td className="rc-mono break-words px-3 py-2 text-[12px] text-[var(--rc-ink)]">
                              {row.stepId}
                            </td>
                            <td
                              className="rc-mono px-3 py-2 text-[12px]"
                              style={{ color: row.color }}
                              title={row.tip}
                            >
                              {row.label}
                            </td>
                            <td className="break-words px-3 py-2 text-[12px] leading-relaxed text-[var(--rc-ink-dim)]">
                              {row.note}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Panel>

            {/* 2b. The notices behind those rows. Directly under the evidence table because three of the
              scored steps are answered from a notice, so "returned nothing" above and "matched no
              notices" here are the same fact stated at two levels of detail. Reads the case's own
              persisted rows rather than the notices table, so it shows what the agent saw; `steps` is
              the fallback for cases proposed before those rows were stored. */}
            <MatchedNoticesPanel
              noticeSearch={recon.notice_search}
              steps={steps}
            />

            {/* 3. What Tier-1 concluded deterministically, before the agent was dispatched — read
              after the agent's own findings, as the cheaper answer they either confirm or overturn.
              It sat above everything until 2026-09-03.

              The `!== undefined` check (rather than truthiness) is deliberate:
              tier1_escalation_reason is the one key stamped on EVERY escalation, and it can
              legitimately be null, which a truthiness check would hide in exactly the case worth
              showing. */}
            {idp?.tier1_escalation_reason !== undefined && (
              <Tier1RoutingPanel tier1={idp} agentClass={recon.class_id} />
            )}

            {/* 4. Agent trace: the actual steps the agent took. min-w-0 so a long tool-output line
              wraps rather than widening the page. */}
            <Panel className="rc-rise min-w-0 p-6">
              <div className="flex items-center justify-between">
                <Eyebrow title="The steps the agent actually took: recall → classify → run skill(s) → tool calls → evidence-step reports → propose → (execute when auto-actioned). No per-step confidence — see Evidence Score, which counts the satisfied evidence steps.">
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
                    // An evidence step's dot carries its tri-state outcome: obtained (green), attempted
                    // and empty (amber), never attempted (faint). Amber and faint both score as
                    // unsatisfied but call for different follow-up, so they must not look alike.
                    const dot =
                      s.kind === "execute"
                        ? failed
                          ? "var(--rc-red)"
                          : "var(--rc-green)"
                        : s.kind === "evidence_step"
                          ? s.satisfied === true
                            ? "var(--rc-green)"
                            : s.satisfied === false
                              ? "var(--rc-amber)"
                              : "var(--rc-ink-faint)"
                          : "var(--rc-cyan)";
                    return (
                      <li key={i} className="relative pb-6 pl-6 last:pb-0">
                        {/* timeline rail */}
                        <span
                          className="absolute left-0 top-1 h-2.5 w-2.5 rounded-full"
                          style={{
                            background: dot,
                            boxShadow: `0 0 6px ${dot}`,
                          }}
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
                          {s.kind === "evidence_step" && (
                            <span
                              className="rc-mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
                              style={{ border: `1px solid ${dot}`, color: dot }}
                              title="Whether this prescribed step's tool call returned data answering it. 'Not attempted' means the agent made no such call — the same score as empty, but a different finding."
                            >
                              {s.step_id ?? "step"} ·{" "}
                              {s.satisfied === true
                                ? "Obtained"
                                : s.satisfied === false
                                  ? "Returned nothing"
                                  : "Not attempted"}
                            </span>
                          )}
                          {s.kind === "execute" && s.outcome && (
                            <span
                              className="rc-mono rounded px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
                              style={{
                                border: `1px solid ${failed ? "var(--rc-red)" : "var(--rc-green)"}`,
                                color: failed
                                  ? "var(--rc-red)"
                                  : "var(--rc-green)",
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

            {/* 5. Latest AgentCore evaluation. Last because it scores the session the four sections
              above describe — there is nothing to make of it until you have read them. */}
            <CaseEvalPanel caseId={id} status={recon?.status} />
          </>
        )}
      </div>
    </div>
  );
}

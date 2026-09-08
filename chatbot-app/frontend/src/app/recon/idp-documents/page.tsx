"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listIdpDocuments,
  getIdpDocument,
  listSubmissions,
  listWorkflowTypes,
  type IdpDocument,
  type IdpDocumentDetail,
  type SubmissionRow,
  type WorkflowType,
} from "@/lib/reconApi";
import { DataTable, type DataTableColumn } from "@/components/recon/DataTable";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";
import SourceDocumentPreview from "@/components/recon/SourceDocumentPreview";
import { UploadDialog } from "@/components/recon/UploadDialog";
import { useReconSubject } from "@/hooks/useReconSubject";

// What came out of the document pipeline. Uploads land as email attachments and as files an operator
// drops in; extraction runs somewhere else entirely, and until this tab existed the only way to find out
// whether a notice had been read was to ask whoever ran that pipeline.
//
// The column that earns the tab is `ConfigVersion`. A workflow type on the Config tab pins a version by
// name, typed in by hand because nothing exposes the list of valid names. That typo has no other symptom:
// the upload succeeds, the wrong configuration runs, and the extraction is quietly worse. Here the pinned
// name and the used name sit in the same row, so the disagreement is something an operator can see.
//
// The table shows ONLY the configuration versions this deployment's workflow types pin. That pipeline is
// shared: most of what it has processed was queued by something else entirely, against configurations
// recon has never heard of, and listing those rows here made the tab read as recon's history when almost
// none of it was. Hidden rows are counted rather than dropped silently — see the caption under the
// filter — because "no documents" and "documents, none of them ours" are different answers.
//
// Clicking a row opens its detail inside the table, directly under that row, with a live view of the
// source file beside the extracted record. The file comes from the extraction pipeline's input bucket
// through this app's own route rather than from the pipeline's API, which exposes no URL for it — see
// `src/app/api/recon/idp-documents/[objectKey]/source/route.ts`.
//
// Deliberately absent, because the upstream API has no such thing: a production/test filter and a total
// count. Where the pipeline gave us a review URL the detail links out to it, for the reviewer's own
// corrections; the file itself no longer needs that trip.

/** Days of history the tab opens with. Long enough to cover a month-end run. */
const DEFAULT_WINDOW_DAYS = 30;

const INPUT =
  "rc-mono w-full border border-[var(--rc-line)] bg-transparent px-2 py-1.5 text-[12px] text-[var(--rc-ink)] outline-none focus:border-[var(--rc-cyan)]";
const BUTTON =
  "rc-mono border border-[var(--rc-line)] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-[var(--rc-ink-faint)] transition-colors hover:border-[var(--rc-cyan)] hover:text-[var(--rc-ink)] disabled:cursor-not-allowed disabled:opacity-40";

/** `2026-09-02` for a date input, in the viewer's own timezone rather than UTC. */
function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The file name an operator recognises. Keys are long and prefixed; the tail is the part they typed. */
function basename(key: string | null): string {
  if (!key) return "—";
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

/** Local time, or an em dash. The pipeline reports UTC; an operator reads their own clock. */
function localTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

// The pipeline's statuses are its own vocabulary, not the case queue's, so this maps them here rather
// than widening the shared `StatusPill`. Anything unrecognised renders dim instead of guessing a colour.
const STATUS_COLOR: Record<string, string> = {
  COMPLETED: "var(--rc-green)",
  SUCCEEDED: "var(--rc-green)",
  RUNNING: "var(--rc-violet)",
  QUEUED: "var(--rc-amber)",
  PENDING: "var(--rc-amber)",
  FAILED: "var(--rc-red)",
  TIMED_OUT: "var(--rc-red)",
  ABORTED: "var(--rc-red)",
};

/**
 * A status as a coloured chip.
 *
 * @param status - the pipeline's status string, or null for a row that has not reported one.
 */
function DocStatus({ status }: { status: string | null }) {
  if (!status)
    return (
      <span className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">—</span>
    );
  const color = STATUS_COLOR[status] ?? "var(--rc-ink-dim)";
  return (
    <span
      className="rc-mono inline-block border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.1em]"
      style={{ color, borderColor: color }}
    >
      {status}
    </span>
  );
}

/**
 * The full record for one document, rendered inside its own row in the table.
 *
 * The source file sits on the left and what was extracted from it on the right, deliberately in one
 * view: every number on the right is a claim ABOUT the document, and checking a low-confidence
 * attribute means reading the page it came from. Two fetches, not one — the record and the file are
 * independent, so a pipeline API that answers while the bucket does not (or the reverse) shows one
 * side and says why the other is missing, instead of blanking both.
 *
 * @param objectKey - the key to read.
 * @param onClose - called when the panel is dismissed.
 */
function DocumentDetail({
  objectKey,
  onClose,
}: {
  objectKey: string;
  onClose: () => void;
}) {
  const [doc, setDoc] = useState<IdpDocumentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    getIdpDocument(objectKey)
      .then(setDoc)
      .catch((e) => setError(String(e)));
  }, [objectKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Eyebrow>Document detail</Eyebrow>
          <h2
            className="rc-mono mt-2 break-all text-[13px] text-[var(--rc-ink)]"
            title={objectKey}
          >
            {objectKey}
          </h2>
        </div>
        <button type="button" className={BUTTON} onClick={onClose}>
          Close
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <div className="rc-eyebrow">Source document</div>
          <SourceDocumentPreview objectKey={objectKey} className="mt-2" />
        </div>

        <div className="space-y-4">
          {error ? (
            <Placeholder kind="error">
              Failed to load document — {error}
            </Placeholder>
          ) : !doc ? (
            <Placeholder kind="loading">◆ reading document…</Placeholder>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  ["Object status", doc.ObjectStatus],
                  ["Workflow status", doc.WorkflowStatus],
                  ["Config version", doc.ConfigVersion],
                  ["Evaluation", doc.EvaluationStatus],
                  ["Queued", localTime(doc.QueuedTime)],
                  ["Started", localTime(doc.InitialEventTime)],
                  ["Completed", localTime(doc.CompletionTime)],
                  [
                    "Pages",
                    doc.PageCount === null ? "—" : String(doc.PageCount),
                  ],
                ].map(([label, value]) => (
                  <div key={label as string}>
                    <div className="rc-eyebrow">{label}</div>
                    <div className="rc-mono mt-1 break-all text-[12px] text-[var(--rc-ink)]">
                      {value || "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* Review state, and the way out to the pipeline's own UI. The link is not a second route
                  to the file — it opens the pipeline's review screen, where a reviewer's corrections
                  live. This tab shows the document; that UI is where it gets changed. */}
              <div className="border-t border-[var(--rc-line)] pt-4">
                <div className="rc-eyebrow">Human review</div>
                <p className="rc-mono mt-2 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
                  {doc.HITLTriggered
                    ? `Review was triggered${doc.HITLStatus ? ` — ${doc.HITLStatus}` : ""}${
                        doc.HITLReviewedBy
                          ? `, reviewed by ${doc.HITLReviewedBy}`
                          : ""
                      }.`
                    : "No review was triggered for this document."}
                </p>
                {doc.HITLReviewURL && (
                  <a
                    href={doc.HITLReviewURL}
                    target="_blank"
                    rel="noreferrer"
                    className={`${BUTTON} mt-3 inline-block`}
                  >
                    Open in review UI ↗
                  </a>
                )}
              </div>

              <div className="border-t border-[var(--rc-line)] pt-4">
                <div className="rc-eyebrow">
                  Sections and confidence alerts
                  {doc.ConfidenceAlertCount
                    ? ` (${doc.ConfidenceAlertCount})`
                    : ""}
                </div>
                {!doc.Sections || doc.Sections.length === 0 ? (
                  <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink-dim)]">
                    ◇ no sections recorded
                  </p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {doc.Sections.map((s, i) => (
                      <div
                        key={s.Id ?? i}
                        className="border border-[var(--rc-line)] p-3"
                      >
                        <div className="rc-mono flex flex-wrap items-baseline gap-x-3 text-[12px] text-[var(--rc-ink)]">
                          <span>{s.Class ?? "unclassified"}</span>
                          <span className="text-[var(--rc-ink-dim)]">
                            pages {s.PageIds?.join(", ") || "—"}
                          </span>
                          {s.Excluded && (
                            <span className="text-[var(--rc-amber)]">
                              excluded
                              {s.ExclusionReason
                                ? ` — ${s.ExclusionReason}`
                                : ""}
                            </span>
                          )}
                        </div>
                        {/* An alert means the extractor was below its own threshold for that attribute.
                            Showing the two numbers side by side says how far below, which is the
                            difference between "re-check this figure" and "re-key the whole page" — and
                            the page itself is on the left, which is what makes that call possible. */}
                        {s.ConfidenceThresholdAlerts &&
                          s.ConfidenceThresholdAlerts.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {s.ConfidenceThresholdAlerts.map((a, j) => (
                                <li
                                  key={`${a.attributeName ?? j}`}
                                  className="rc-mono text-[11px] text-[var(--rc-amber)]"
                                >
                                  {a.attributeName ?? "attribute"} —{" "}
                                  {a.confidence === null
                                    ? "?"
                                    : a.confidence.toFixed(2)}{" "}
                                  below{" "}
                                  {a.confidenceThreshold === null
                                    ? "?"
                                    : a.confidenceThreshold.toFixed(2)}
                                </li>
                              ))}
                            </ul>
                          )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The single status to show for a submission whose files may disagree.
 *
 * Worst-first, because a submission with one FAILED file among four is a submission that needs
 * attention: rolling it up to the majority status would hide the file that did not arrive.
 */
function rollup(files: SubmissionRow["files"]): string {
  const statuses = new Set(files.map((f) => f.status));
  for (const worst of ["FAILED", "PENDING", "PENDING_INGESTION"]) {
    if (statuses.has(worst as never)) return worst;
  }
  return files.length > 0 ? files[0].status : "—";
}

export default function IdpDocumentsPage() {
  const { subject: sub, isAdmin } = useReconSubject();

  const [start, setStart] = useState(() =>
    toDateInput(new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86400_000)),
  );
  const [end, setEnd] = useState(() => toDateInput(new Date()));
  const [rows, setRows] = useState<IdpDocument[] | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionRow[] | null>(null);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  // The pins, read from the Config tab's own list. Null until they arrive; an error here leaves the
  // table unfiltered rather than empty, with the reason said out loud — a filter that cannot be built
  // must not be indistinguishable from a filter that matched nothing.
  const [workflowTypes, setWorkflowTypes] = useState<WorkflowType[] | null>(
    null,
  );
  const [workflowTypesError, setWorkflowTypesError] = useState<string | null>(
    null,
  );

  /**
   * Read one page.
   *
   * @param token - continuation token to append to the loaded rows, or null to start over.
   */
  const load = useCallback(
    async (token: string | null) => {
      setLoading(true);
      setError(null);
      try {
        // The dates are whole days in the viewer's timezone; the end is pushed to the following midnight
        // so that "to today" includes documents that arrived an hour ago.
        const startIso = new Date(`${start}T00:00:00`).toISOString();
        const endIso = new Date(
          new Date(`${end}T00:00:00`).getTime() + 86400_000,
        ).toISOString();
        const page = await listIdpDocuments({
          startDateTime: startIso,
          endDateTime: endIso,
          nextToken: token,
        });
        setRows((prev) =>
          token ? [...(prev ?? []), ...page.documents] : page.documents,
        );
        setNextToken(page.nextToken);
      } catch (e) {
        setError(String(e));
        if (!token) setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [start, end],
  );

  // Separate from `load`: this reads recon's own audit table, and the date window above belongs to
  // the pipeline's API. Tying the two together would make an upload disappear from this tab because
  // somebody narrowed the dates to look at an extraction from last week.
  const loadSubmissions = useCallback(async () => {
    try {
      setSubmissions(await listSubmissions());
      setSubmissionsError(null);
    } catch (e) {
      setSubmissionsError(String(e));
      setSubmissions([]);
    }
  }, []);

  useEffect(() => {
    void load(null);
    void loadSubmissions();
    listWorkflowTypes()
      .then((types) => {
        setWorkflowTypes(types);
        setWorkflowTypesError(null);
      })
      .catch((e) => {
        setWorkflowTypes([]);
        setWorkflowTypesError(e instanceof Error ? e.message : String(e));
      });
    // Intentionally not keyed on `load`: changing a date should arm the Apply button, not refetch on
    // every keystroke while the operator is still typing the year.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The configuration versions this deployment pins, in the operator's own casing for the caption and
  // lowercased for the comparison. Retired types are included: a document processed last month was
  // processed against the version its type pinned then, and dropping retired pins would erase it from
  // this tab for no reason anyone could see.
  const pinnedVersions = useMemo(() => {
    const labels = new Set<string>();
    for (const t of workflowTypes ?? []) {
      const v = t.idp_config_version?.trim();
      if (t.route === "extraction" && v) labels.add(v);
    }
    return [...labels].sort();
  }, [workflowTypes]);

  // Matched case-insensitively. The pin is typed by hand, and a version pinned as `Recon-IDP` against a
  // pipeline that reports `recon-idp` is the same configuration — hiding those rows would be a worse
  // outcome than the casing disagreement itself.
  const pinnedLower = useMemo(
    () => new Set(pinnedVersions.map((v) => v.toLowerCase())),
    [pinnedVersions],
  );

  // Two filters, in order. First: only the configurations this deployment pins — unless the pins could
  // not be read at all, in which case everything is shown and the error below explains why.
  const ours = useMemo(() => {
    if (!rows) return [];
    if (workflowTypes === null || workflowTypesError) return rows;
    return rows.filter((r) =>
      pinnedLower.has((r.ConfigVersion ?? "").trim().toLowerCase()),
    );
  }, [rows, workflowTypes, workflowTypesError, pinnedLower]);

  // Second: the operator's text, over the rows already loaded rather than a server-side search — there
  // is no search argument on the upstream query. The caption below says so, because a filter that
  // silently searches one page is indistinguishable from a document that was never processed.
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ours;
    return ours.filter((r) =>
      [r.ObjectKey, r.ConfigVersion, r.ObjectStatus, r.WorkflowStatus]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q)),
    );
  }, [ours, filter]);

  /** Rows the pipeline returned that belong to some other deployment's configuration. */
  const hiddenByConfig = (rows?.length ?? 0) - ours.length;

  const columns = useMemo<DataTableColumn<IdpDocument>[]>(
    () => [
      {
        id: "document",
        header: "Document",
        width: "minmax(0,2fr)",
        cell: (d) => (
          <span
            className="rc-mono block truncate text-[12px] text-[var(--rc-ink)]"
            title={d.ObjectKey ?? undefined}
          >
            {basename(d.ObjectKey)}
          </span>
        ),
        sortValue: (d) => basename(d.ObjectKey).toLowerCase(),
      },
      {
        id: "status",
        header: "Status",
        cell: (d) => <DocStatus status={d.ObjectStatus} />,
        sortValue: (d) => d.ObjectStatus ?? null,
      },
      {
        id: "started",
        header: "Started",
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {localTime(d.InitialEventTime)}
          </span>
        ),
        // Sorted on the raw timestamp, not the formatted string, so ordering does not depend on locale.
        sortValue: (d) => d.InitialEventTime ?? null,
      },
      {
        id: "config_version",
        header: "Config version",
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
            {d.ConfigVersion ?? "—"}
          </span>
        ),
        sortValue: (d) => d.ConfigVersion ?? null,
      },
      {
        id: "workflow_status",
        header: "Workflow",
        defaultHidden: true,
        cell: (d) => <DocStatus status={d.WorkflowStatus} />,
        sortValue: (d) => d.WorkflowStatus ?? null,
      },
      {
        id: "completed",
        header: "Completed",
        defaultHidden: true,
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {localTime(d.CompletionTime)}
          </span>
        ),
        sortValue: (d) => d.CompletionTime ?? null,
      },
      {
        id: "pages",
        header: "Pages",
        defaultHidden: true,
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {d.PageCount === null ? "—" : d.PageCount}
          </span>
        ),
        sortValue: (d) => d.PageCount,
      },
      {
        id: "alerts",
        header: "Alerts",
        defaultHidden: true,
        cell: (d) => (
          <span
            className="rc-mono text-[12px]"
            style={{
              color: d.ConfidenceAlertCount
                ? "var(--rc-amber)"
                : "var(--rc-ink-faint)",
            }}
          >
            {d.ConfidenceAlertCount === null ? "—" : d.ConfidenceAlertCount}
          </span>
        ),
        sortValue: (d) => d.ConfidenceAlertCount,
      },
      {
        id: "evaluation",
        header: "Eval",
        defaultHidden: true,
        cell: (d) => <DocStatus status={d.EvaluationStatus} />,
        sortValue: (d) => d.EvaluationStatus ?? null,
      },
      {
        id: "hitl_status",
        header: "Review",
        defaultHidden: true,
        cell: (d) => <DocStatus status={d.HITLStatus} />,
        sortValue: (d) => d.HITLStatus ?? null,
      },
      {
        id: "hitl_triggered",
        header: "Review asked",
        defaultHidden: true,
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {d.HITLTriggered === null ? "—" : d.HITLTriggered ? "yes" : "no"}
          </span>
        ),
        sortValue: (d) =>
          d.HITLTriggered === null ? null : String(d.HITLTriggered),
      },
      {
        id: "hitl_completed",
        header: "Review done",
        defaultHidden: true,
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {d.HITLCompleted === null ? "—" : d.HITLCompleted ? "yes" : "no"}
          </span>
        ),
        sortValue: (d) =>
          d.HITLCompleted === null ? null : String(d.HITLCompleted),
      },
      {
        id: "reviewer",
        header: "Reviewer",
        defaultHidden: true,
        cell: (d) => (
          <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            {d.HITLReviewedBy ?? d.HITLReviewOwner ?? "—"}
          </span>
        ),
        sortValue: (d) => d.HITLReviewedBy ?? d.HITLReviewOwner ?? null,
      },
    ],
    [],
  );

  const uploadColumns = useMemo<DataTableColumn<SubmissionRow>[]>(
    () => [
      {
        id: "uploaded_at",
        header: "Uploaded",
        cell: (s) => localTime(s.uploaded_at),
        sortValue: (s) => s.uploaded_at,
        width: "180px",
      },
      {
        id: "files",
        header: "Files",
        // Names, not a count. "3 files" tells an operator nothing about which upload this was.
        cell: (s) => s.files.map((f) => f.filename).join(", "),
        sortValue: (s) => s.files.length,
      },
      {
        id: "route",
        header: "Route",
        cell: (s) => s.route,
        sortValue: (s) => s.route,
        width: "150px",
      },
      {
        id: "workflow_type",
        header: "Workflow type",
        cell: (s) => s.workflow_type,
        sortValue: (s) => s.workflow_type,
      },
      {
        id: "config_version",
        header: "Config version",
        cell: (s) => s.config_version || "—",
        sortValue: (s) => s.config_version,
        defaultHidden: true,
      },
      {
        id: "uploaded_by",
        header: "By",
        cell: (s) => s.uploaded_by,
        sortValue: (s) => s.uploaded_by,
        defaultHidden: true,
      },
      {
        id: "status",
        header: "Status",
        cell: (s) => rollup(s.files),
        sortValue: (s) => rollup(s.files),
        width: "160px",
      },
    ],
    [],
  );

  return (
    <div className="space-y-6">
      <header>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Read from the document pipeline</Eyebrow>
            <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
              Documents
            </h1>
          </div>
          {/* Hidden from a non-admin, and that is presentation only. The route runs
              `requireReconAdmin` on every request and 403s regardless of what the browser rendered --
              this just avoids offering a button whose only outcome is a 403. `isAdmin` comes from
              `/api/recon/me`, the same signal the nav uses to gate the Config tab. */}
          {isAdmin && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => setShowUpload(true)}
            >
              Upload
            </button>
          )}
        </div>
        <p className="rc-mono mt-3 max-w-3xl text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
          What the extraction pipeline processed against the configuration
          versions this deployment pins, newest window first. That pipeline is
          shared, so anything queued against another configuration is left out —
          the <span className="text-[var(--rc-ink)]">Config version</span>{" "}
          column shows which pin each row ran under. If a version you expected
          is missing entirely, the pin on the Config tab is spelled differently
          from what the pipeline was given.
        </p>
      </header>

      <Panel className="rc-rise p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="rc-eyebrow">From</span>
            <input
              type="date"
              className={`${INPUT} mt-1 w-[150px]`}
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="rc-eyebrow">To</span>
            <input
              type="date"
              className={`${INPUT} mt-1 w-[150px]`}
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
          <button
            type="button"
            className={BUTTON}
            disabled={loading}
            onClick={() => {
              setNextToken(null);
              void load(null);
            }}
          >
            {loading ? "Loading…" : "Apply"}
          </button>
          <label className="ml-auto block min-w-[220px] flex-1">
            <span className="rc-eyebrow">Filter loaded rows</span>
            <input
              className={`${INPUT} mt-1`}
              placeholder="file name, config version, status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </label>
        </div>
        <p className="rc-mono mt-3 text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
          The filter searches the {ours.length} rows loaded so far, not the
          whole window — the pipeline&rsquo;s API has no search. Widen the dates
          or load more pages if what you want is missing.
        </p>
        {/* The pins, spelled out. This is the only place an operator can see WHY a document they know was
            processed is not on this page, and the answer is almost always that its configuration is not
            one of these. */}
        {workflowTypesError ? (
          <p
            className="rc-mono mt-2 text-[11px] leading-relaxed"
            style={{ color: "var(--rc-amber)" }}
          >
            Could not read the configured workflow types — {workflowTypesError}.
            Every row the pipeline returned is shown, including other
            deployments&rsquo; configurations.
          </p>
        ) : workflowTypes === null ? (
          <p className="rc-mono mt-2 text-[11px] text-[var(--rc-ink-dim)]">
            ◆ reading the configured versions…
          </p>
        ) : (
          <p className="rc-mono mt-2 text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
            {pinnedVersions.length === 0
              ? "No workflow type pins a configuration version, so no row can be recognised as this deployment's. Pin one on the Config tab."
              : `Showing only these configuration versions, pinned by the workflow types on the Config tab: ${pinnedVersions.join(", ")}.`}
            {hiddenByConfig > 0 &&
              ` ${hiddenByConfig} loaded ${hiddenByConfig === 1 ? "row belongs" : "rows belong"} to another configuration and ${hiddenByConfig === 1 ? "is" : "are"} hidden.`}
          </p>
        )}
      </Panel>

      {error && (
        <Placeholder kind="error">
          Failed to read documents — {error}
        </Placeholder>
      )}

      {!rows ? (
        <Placeholder kind="loading">◆ reading documents…</Placeholder>
      ) : (
        <>
          {shown.length === 0 ? (
            <Placeholder kind="empty">
              {rows.length === 0
                ? "◇ no documents processed in this window"
                : ours.length === 0
                  ? `◇ ${rows.length} documents loaded, none of them against a configuration version this deployment pins`
                  : "◇ no loaded rows match this filter"}
            </Placeholder>
          ) : (
            <DataTable
              tableId="idp-documents"
              sub={sub}
              columns={columns}
              rows={shown}
              rowKey={(d) => d.ObjectKey ?? ""}
              // A toggle, not an open: clicking the row that is already open shuts it. Without that the
              // only way out is the Close button, and a row whose click does nothing reads as broken.
              onRowClick={(d) =>
                d.ObjectKey &&
                setSelected((prev) =>
                  prev === d.ObjectKey ? null : (d.ObjectKey as string),
                )
              }
              expandedRow={(d) =>
                d.ObjectKey && d.ObjectKey === selected ? (
                  <DocumentDetail
                    objectKey={d.ObjectKey}
                    onClose={() => setSelected(null)}
                  />
                ) : null
              }
              paginated
            />
          )}
          {/* Outside the branch above, deliberately. A page of the pipeline's rows can be entirely other
              deployments' configurations while the next page holds ours, and hiding Load more on an empty
              table would leave the operator with nothing to press. */}
          <div className="flex items-center gap-3">
            {/* An explicit button, not infinite scroll: each press is one signed request to somebody
                else's API, and an operator scrolling a long window should not fire ten of them. */}
            <button
              type="button"
              className={BUTTON}
              disabled={loading || !nextToken}
              onClick={() => void load(nextToken)}
            >
              {loading
                ? "Loading…"
                : nextToken
                  ? "Load more"
                  : "All rows loaded"}
            </button>
            <span className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
              {rows.length} loaded
              {hiddenByConfig > 0
                ? ` · ${ours.length} on a pinned configuration`
                : ""}
              {filter.trim() ? ` · ${shown.length} shown` : ""}
            </span>
          </div>
        </>
      )}

      <Panel className="rc-rise space-y-3 p-4">
        <h2 className="rc-display text-[20px] font-black text-[var(--rc-ink)]">
          Recent uploads
        </h2>
        {/* Why this is a separate table and not more rows in the one above: a knowledge-base upload
            never reaches the extraction pipeline, and a refused file never reaches a bucket at all.
            Neither has a row up there, and both are exactly what somebody comes to this tab to
            check after an upload. */}
        <p className="rc-mono text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
          What recon sent, from its own audit record. Knowledge-base uploads and
          refused files appear only here — the table above is the extraction
          pipeline&rsquo;s own view, and neither ever reaches it.
        </p>
        {submissionsError && (
          <Placeholder kind="error">
            Failed to read uploads — {submissionsError}
          </Placeholder>
        )}
        {!submissions ? (
          <Placeholder kind="loading">◆ reading uploads…</Placeholder>
        ) : submissions.length === 0 ? (
          <Placeholder kind="empty">◇ nothing uploaded yet</Placeholder>
        ) : (
          <>
            <DataTable
              tableId="recon-uploads"
              sub={sub}
              columns={uploadColumns}
              rows={submissions}
              rowKey={(s) => s.submission_id}
              paginated
            />
            {/* The reasons, spelled out. The rollup column can only say FAILED, and a status with no
                reason beside it sends the operator to CloudWatch for something already recorded. */}
            {submissions
              .flatMap((s) =>
                // Carrying the submission id along is what keeps the React key unique: the same
                // file name legitimately appears in two submissions, and a duplicated key would
                // drop one of the two reasons from the page.
                s.files
                  .filter((f) => f.error)
                  .map((f) => ({ ...f, submission_id: s.submission_id })),
              )
              .map((f) => (
                <p
                  key={`${f.submission_id}/${f.filename}`}
                  className="rc-mono text-[11px] text-[var(--rc-amber)]"
                >
                  {f.filename} — {f.error}
                </p>
              ))}
          </>
        )}
      </Panel>

      {showUpload && (
        <UploadDialog
          onClose={() => setShowUpload(false)}
          onUploaded={() => void loadSubmissions()}
        />
      )}
    </div>
  );
}

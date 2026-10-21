"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listIdpDocuments,
  getIdpDocument,
  getIdpExtraction,
  getIdpExtractions,
  listSubmissions,
  listWorkflowTypes,
  type ExtractedSection,
  type NoticeExtraction,
  type IdpDocument,
  type IdpDocumentDetail,
  type SubmissionRow,
  type WorkflowType,
} from "@/lib/reconApi";
import { DataTable, type DataTableColumn } from "@/components/recon/DataTable";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";
import SourceDocumentPreview from "@/components/recon/SourceDocumentPreview";
import { ExtractedFields } from "@/components/recon/ExtractedFields";
import {
  confidenceByField,
  confidenceText,
  fieldText,
  flattenExtractedFields,
  isBelowThreshold,
} from "@/lib/idpFields";
import { UploadDialog } from "@/components/recon/UploadDialog";
import { useReconSubject } from "@/hooks/useReconSubject";

// What recon recorded about every document the extraction pipeline handled. Uploads land as email
// attachments and as files an operator drops in; the extraction itself runs in that pipeline, but this
// tab reads RECON'S OWN notice table, which the IDP post-processing hook writes at ingest — see
// `src/lib/idpDocumentStore.ts`. Until this tab existed the only way to find out whether a notice had
// been read was to ask whoever ran that pipeline.
//
// The column that earns the tab is `ConfigVersion`. A workflow type on the Config tab pins a version by
// name, typed in by hand because nothing exposes the list of valid names. That typo has no other symptom:
// the upload succeeds, the wrong configuration runs, and the extraction is quietly worse. Here the pinned
// name and the used name sit in the same row, so the disagreement is something an operator can see.
//
// The table opens on the configuration versions this deployment's workflow types pin, AND the rows recon
// recorded no version for at all. The pipeline is shared and the hook fires for everything it finishes,
// so recon's own table holds rows for documents queued by something else entirely, against
// configurations recon has never heard of. Listing those made the tab read as recon's history when
// almost none of it was.
//
// That restriction is the FILTER BOX'S OWN VALUE, not an invisible rule: the pinned versions are seeded
// into the box once they load, so an operator can read what is being applied to them and CLEAR IT to get
// every loaded row back. It used to be applied silently, with a paragraph of prose underneath as its only
// evidence and no way off it at all.
//
// The rows with no version are the pre-change history: recon's own notices from before the hook captured
// a tracking snapshot, put into this tab's index by a backfill precisely so they would be visible. They
// are shown with their provenance marked rather than filtered out, because an ABSENT version is not a
// FOREIGN one — see `matchesFilterTerm`, which is the part a reader is otherwise likely to "tighten"
// back.
//
// Clicking a row opens its detail inside the table, directly under that row, with a live view of the
// source file beside the extracted record. The file comes from the pipeline's input bucket through this
// app's own route, which resolves the key against recon's own row before reading a byte: raw documents
// are deliberately not copied into recon's storage — see
// `src/app/api/recon/idp-documents/[objectKey]/source/route.ts`.
//
// Deliberately absent: a production/test filter, because recon stores no such flag, and any count of the
// window at all — the strip that used to carry one is gone, and the table's own pager says how much is in
// front of the operator. Absent for a harder reason: anything about human review. The pipeline's
// completion event carries no review fields at all, so recon holds none and this tab says nothing about
// it — rendering "no review was triggered" from an absent field would answer a question recon cannot
// answer. What survives of the way out to the pipeline's own UI is the report pointers in the detail panel.

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

/** Local time, or an em dash. The stored timestamps are UTC; an operator reads their own clock. */
function localTime(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

/**
 * Why a derived start time cannot be read as an ingest time. One sentence, shown in two places.
 *
 * Most of the history carries one: the backfill that put the pre-existing rows into this tab's index had
 * no ingest timestamp to use, so it derived one from the notice's own BUSINESS date. Those dates scatter
 * across the year and one of them is in the future, so in a wide window they sort above documents that
 * genuinely arrived this week.
 */
const APPROXIMATE_START_TITLE =
  "Approximate. This row predates recon's tracking snapshot, so its time was derived from the " +
  "notice's own date — the document's business date, not when the pipeline ran it. Its position in " +
  "this list is approximate.";

/**
 * Why a row can carry no configuration version at all. One sentence, shown in two places.
 *
 * Not the same statement as "another deployment's configuration": the pipeline records the version it
 * ran, so a foreign document always has a NAME here. Nothing means nothing was ever captured.
 */
const UNKNOWN_CONFIG_TITLE =
  "Recon recorded no configuration version for this row. It predates recon's tracking snapshot, so no " +
  "version was ever captured and it cannot be attributed to a pinned one. It is still recon's own row: " +
  "a document processed against another deployment's configuration always reports a version name.";

/**
 * True when recon recorded no configuration version for this row.
 *
 * Trimmed and empty-checked rather than a plain null test, so a stored blank cannot be mistaken for a
 * version name — the same normalisation the pinned-version comparison does.
 *
 * @param d - one loaded row.
 * @returns true when there is no version to compare against the pins.
 */
function hasNoConfigVersion(d: IdpDocument): boolean {
  return (d.ConfigVersion ?? "").trim() === "";
}

/**
 * A row's configuration version, normalised for comparison against the pins.
 *
 * @param d - one loaded row.
 * @returns the version, trimmed and lowercased.
 */
function configKey(d: IdpDocument): string {
  return (d.ConfigVersion ?? "").trim().toLowerCase();
}

/**
 * Does one term from the filter box admit this row?
 *
 * Two kinds of term, and which one a term is depends on the pins rather than on how it was typed:
 *
 * A term that IS one of the pinned configuration versions is the CONFIGURATION RESTRICTION — the rule
 * that used to be applied invisibly before the operator's text ever ran. It admits rows carrying that
 * version, matched case-insensitively because the pin is typed by hand and a version pinned as
 * `Recon-IDP` against a pipeline reporting `recon-idp` is the same configuration.
 *
 * ⚠️ It ALSO admits rows with NO version at all. That is not a hole in the filter: an ABSENT version is a
 * different fact from a FOREIGN one. A document processed against another deployment's configuration
 * always reports a version NAME (`default`, `slim15-assess-no-granular` — both live in this deployment's
 * table right now), because the pipeline records what it ran. Null happens only where no snapshot was
 * ever captured, which is exactly recon's own rows from before the tracking snapshot existed — the 16
 * rows the backfill put into this index to make that history visible. Excluding them defeated the
 * backfill and left the tab showing a third of the history it had, with no symptom other than a shorter
 * table. Do NOT "tighten" this to the version comparison alone; their unknown provenance is stated on the
 * row instead, in the Config version column.
 *
 * Any other term is free text over the fields a reader can SEE. `ObjectStatus` is deliberately not among
 * them, for the same reason it has no column: the hook observes it mid-evaluation, so it is `EVALUATING`
 * on every row, and searching a constant either matches everything or nothing.
 *
 * @param row - one loaded row.
 * @param term - one comma-separated term from the box, already trimmed and lowercased.
 * @param pinnedLower - every configuration version this deployment pins, lowercased.
 * @returns true when this term admits the row.
 */
function matchesFilterTerm({
  row,
  term,
  pinnedLower,
}: {
  row: IdpDocument;
  term: string;
  pinnedLower: Set<string>;
}): boolean {
  if (pinnedLower.has(term))
    return hasNoConfigVersion(row) || configKey(row) === term;
  return [row.ObjectKey, row.ConfigVersion, row.WorkflowStatus]
    .filter(Boolean)
    .some((v) => (v as string).toLowerCase().includes(term));
}

/**
 * A configuration version, marked when recon never recorded one.
 *
 * The marker is VISIBLE and not only a tooltip, for the same reason the derived-time marker is: these
 * rows are shown alongside rows whose version was checked against the pins, and a bare em dash reads as
 * "no version" when what it means is "not attributable to a pin, and included anyway".
 *
 * @param version - the version recon stored, or null when it stored none.
 */
function ConfigVersionCell({ version }: { version: string | null }) {
  if ((version ?? "").trim() !== "")
    return (
      <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
        {version}
      </span>
    );
  return (
    <span
      className="rc-mono text-[12px] text-[var(--rc-ink-faint)]"
      title={UNKNOWN_CONFIG_TITLE}
    >
      —<span className="ml-1.5 text-[var(--rc-amber)]">?</span>
    </span>
  );
}

/**
 * What the Alerts count includes, and what it deliberately leaves out. Shown on the header and the cell.
 *
 * The column is `confidence_alert_count`, which `below_threshold_count` in
 * `backend/idp_hook/explainability.py` computes over the fields the extractor actually READ A VALUE FOR
 * (`rec["extracted"]`). The detail panel lists the pipeline's own raw flags instead, and those include
 * attributes the extractor found nothing for — which arrive as `0.00` against a `0.80` threshold. So the
 * panel legitimately lists more entries than this column counts, and BOTH numbers are right.
 *
 * Recon's number is also the one the gateway interceptor refuses ledger writes on, so it is not free to
 * be redefined to match the panel. The disagreement is explained on screen instead: here, and in the
 * sentence under the panel's own heading.
 */
const EXTRACTED_ALERTS_TITLE =
  "Counts only attributes the extractor read a value for and scored below that attribute's own " +
  "threshold. The pipeline also flags attributes it found no value for at all; those are listed in the " +
  "document's detail panel and are deliberately not counted here, so the panel can show more of them " +
  "than this counts.";

/** Why the evaluation status can disagree with the pipeline. One sentence, shown in two places. */
const EVALUATION_SNAPSHOT_TITLE =
  "As at extraction. Recon's hook runs while the pipeline is still evaluating, so this is the status " +
  "at that moment and a later change is not reflected here.";

/**
 * A start time, marked when it was derived rather than observed.
 *
 * The marker is VISIBLE and not only a tooltip. This column sorts, most of the loaded history carries a
 * derived value, and a reader ordering by it would otherwise have no way to tell a real ingest time from
 * a business date standing in for one — the ordering would look authoritative and be partly guessed.
 *
 * @param iso - the stored timestamp, or null.
 * @param approximate - true when the timestamp was derived from the notice date.
 */
function StartedTime({
  iso,
  approximate,
}: {
  iso: string | null;
  approximate: boolean;
}) {
  return (
    <span className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
      {localTime(iso)}
      {approximate && (
        <span
          className="ml-1.5 text-[var(--rc-amber)]"
          title={APPROXIMATE_START_TITLE}
        >
          ≈
        </span>
      )}
    </span>
  );
}

/**
 * A pointer to one of the pipeline's own report objects.
 *
 * An `s3://` URI is NOT rendered as an anchor: a browser has no handler for that scheme, so the link
 * would look openable and do nothing. Those show the URI itself, which is what an operator pastes into
 * the S3 console or `aws s3 cp`. A configuration that publishes its reports over HTTP gets a real link.
 *
 * @param label - what the report is.
 * @param uri - the pointer recon stored, verbatim.
 */
function ReportLink({ label, uri }: { label: string; uri: string }) {
  if (/^https?:\/\//i.test(uri))
    return (
      <a
        href={uri}
        target="_blank"
        rel="noreferrer"
        className={`${BUTTON} inline-block`}
        title={uri}
      >
        {label} ↗
      </a>
    );
  return (
    <span className="rc-mono block break-all text-[12px] text-[var(--rc-ink)]">
      <span className="text-[var(--rc-ink-faint)]">{label} — </span>
      {uri}
    </span>
  );
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
 * independent, so a notice row that reads while the bucket does not (or the reverse) shows one side
 * and says why the other is missing, instead of blanking both.
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
  // A third fetch, independent of the other two. The extracted values are not in the tracking record
  // `getIdpDocument` returns -- they are embedded on recon's own notice row -- so a document recon
  // never wrote a notice for must show as a named gap under the fields heading while every other part
  // of the panel still renders.
  //
  // Three states, kept apart: `null` is not loaded yet; a non-null `unavailable` is recon having
  // nothing to show AND saying why; `sectionsError` is the read itself failing, which is the only one
  // that is red.
  const [extraction, setExtraction] = useState<NoticeExtraction | null>(null);
  const [sectionsError, setSectionsError] = useState<string | null>(null);

  useEffect(() => {
    setDoc(null);
    setError(null);
    getIdpDocument(objectKey)
      .then(setDoc)
      .catch((e) => setError(String(e)));
  }, [objectKey]);

  useEffect(() => {
    setExtraction(null);
    setSectionsError(null);
    getIdpExtraction(objectKey)
      .then(setExtraction)
      .catch((e) => setSectionsError(String(e)));
  }, [objectKey]);

  // Why recon holds no notice for this document, straight off the row -- present only on a
  // tracking-only row, which is exactly the row that needs explaining.
  const failureReason = doc?.notice_failure_reason ?? null;

  // The one place the two independent fetches are allowed to wait for each other, and only to choose
  // BETWEEN two "no fields" sentences: the row's own reason is the accurate one, so showing
  // `extraction.unavailable`'s inference first and replacing it a moment later would flash a wrong
  // answer. It stops waiting as soon as the tracking read fails, so a failure there still cannot hide
  // the fields.
  const waitingForFailureReason = !doc && !error;

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

      <div className="grid items-start gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        {/* Sticky, because the field list beside it is now long enough to scroll past. The whole claim
            of this layout is that a doubtful figure can be checked against the page it was read from,
            and a preview that scrolled away by the time the operator reached the flagged row would
            leave them scrolling back and forth between the two halves of one comparison. */}
        <div className="lg:sticky lg:top-4">
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
              {/* The third entry of each tuple is a tooltip for the LABEL, used where the value needs a
                  caveat the value itself cannot carry. Typed rather than inferred because one of the
                  values is a node. */}
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    // No "Object status" here either, for the reason given at the Workflow column in
                    // `columns` below: it is `EVALUATING` on every row because recon's hook observes it
                    // mid-evaluation, so beside the two terminal statuses under it, it read as a
                    // contradiction. Still recorded, just not shown.
                    ["Workflow status", doc.WorkflowStatus],
                    // The same marked cell as the column, so a row opened from the table does not
                    // contradict the row it was opened from.
                    [
                      "Config version",
                      <ConfigVersionCell
                        key="config_version"
                        version={doc.ConfigVersion}
                      />,
                    ],
                    // The one snapshot field that genuinely goes stale — hence the caveat in the label
                    // rather than only in a tooltip nobody hovers.
                    [
                      "Evaluation (as at extraction)",
                      doc.EvaluationStatus,
                      EVALUATION_SNAPSHOT_TITLE,
                    ],
                    ["Queued", localTime(doc.QueuedTime)],
                    [
                      "Started",
                      <StartedTime
                        key="started"
                        iso={doc.InitialEventTime}
                        approximate={doc.idp_started_at_approximate === true}
                      />,
                    ],
                    ["Completed", localTime(doc.CompletionTime)],
                    [
                      "Pages",
                      doc.PageCount === null ? "—" : String(doc.PageCount),
                    ],
                  ] as [string, React.ReactNode, string?][]
                ).map(([label, value, hint]) => (
                  <div key={label}>
                    <div className="rc-eyebrow" title={hint}>
                      {label}
                    </div>
                    <div className="rc-mono mt-1 break-all text-[12px] text-[var(--rc-ink)]">
                      {value || "—"}
                    </div>
                  </div>
                ))}
              </div>

              {/* The pipeline's own reports on this document, and the only way out to them: recon stores
                  the pointers the completion event carried, not the reports themselves. Rendered only
                  when the row actually has one — an empty heading would read as a report that exists
                  and cannot be reached. Most configurations write an evaluation report and no summary
                  one, so the two are independent. */}
              {(doc.EvaluationReportURI || doc.SummaryReportURI) && (
                <div className="border-t border-[var(--rc-line)] pt-4">
                  <div className="rc-eyebrow">Pipeline reports</div>
                  <p className="rc-mono mt-2 text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
                    Where the extraction pipeline wrote its own report for this
                    document. Recon holds the pointer, not the report.
                  </p>
                  <div className="mt-3 space-y-2">
                    {doc.EvaluationReportURI && (
                      <ReportLink
                        label="Evaluation report"
                        uri={doc.EvaluationReportURI}
                      />
                    )}
                    {doc.SummaryReportURI && (
                      <ReportLink
                        label="Summary report"
                        uri={doc.SummaryReportURI}
                      />
                    )}
                  </div>
                </div>
              )}

              <div className="border-t border-[var(--rc-line)] pt-4">
                {/* "every attribute the pipeline flagged", not "confidence alerts". What is listed below
                    is the pipeline's RAW flags, and they include attributes the extractor found no value
                    for at all — those arrive as `0.00` against a `0.80` threshold, which under the old
                    heading read as doubt about a value rather than as a value that is not there.
                    The parenthetical is recon's OWN count, the one in the table's Alerts column, so it is
                    labelled as such: it counts a strict subset of this list (see `EXTRACTED_ALERTS_TITLE`)
                    and an unlabelled number beside a longer list reads as a miscount. */}
                <div className="rc-eyebrow">
                  Sections and every attribute the pipeline flagged
                  {doc.ConfidenceAlertCount
                    ? ` (${doc.ConfidenceAlertCount} counted under Alerts)`
                    : ""}
                </div>
                {!doc.Sections || doc.Sections.length === 0 ? (
                  <p className="rc-mono mt-2 text-[12px] text-[var(--rc-ink-dim)]">
                    ◇ no sections recorded
                  </p>
                ) : (
                  <>
                    {/* Why this list is routinely longer than the Alerts column, said on screen because
                        the two numbers are visible together and both are correct. Recon's count requires
                        `extracted` — see `below_threshold_count` in
                        `backend/idp_hook/explainability.py` — and it is the number the gateway
                        interceptor refuses ledger writes on, so neither side is free to be redefined to
                        agree with the other. */}
                    <p className="rc-mono mt-2 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
                      An entry reading 0.00 means the extractor read no value
                      for that attribute at all, not that it was unsure of one.
                      The Alerts column counts only attributes it did extract
                      and scored below their own threshold, which is why it is
                      the smaller number.
                    </p>
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
                  </>
                )}
              </div>
            </>
          )}

          {/* Outside the branch above on purpose: this is a separate request, and it is the half of the
              panel an operator came for. A tracking record that will not load must not take the
              extracted fields with it. */}
          <div className="border-t border-[var(--rc-line)] pt-4">
            <div className="rc-eyebrow">Extracted fields</div>
            {failureReason ? (
              // A tracking-only row: the pipeline finished and recon mapped no notice out of it. Worded
              // as why no notice was MAPPED, because the commonest reason -- no notice date the
              // extractor could read -- is what a document belonging to ANOTHER deployment's
              // configuration looks like from here. Nothing is broken and nobody is at fault.
              <p className="rc-mono mt-1 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
                Recon mapped no notice from this document, so there are no
                fields to show. The reason it recorded is below. A document
                carrying no notice date recon could read is usually one this
                deployment was never meant to reconcile — the source file is
                still on the left.
              </p>
            ) : (
              <p className="rc-mono mt-1 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
                What the extractor read, with the confidence it read each field
                at. Amber means below that field&rsquo;s own threshold — the
                thresholds differ per field, so a 0.85 can be fine in one row
                and flagged in the next. The page it came from is on the left.
              </p>
            )}
            <div className="mt-3">
              {sectionsError ? (
                <Placeholder kind="error">
                  Failed to read what was extracted — {sectionsError}
                </Placeholder>
              ) : failureReason ? (
                // Dim, not red, and the row's own sentence rather than a paraphrase. Kept in
                // preference to `extraction.unavailable` even though the reader now reports this same
                // reason for a tracking-only row: this comes from the document read, which the panel
                // has already awaited, so the two cannot disagree and the accurate one is here first.
                // The reader's old inference from an absent `idp_sections` — "extracted before recon
                // stored per-field detail", plus advice to re-upload — is deleted; see
                // `unavailableReason` in `src/lib/noticeExtraction.ts`.
                <Placeholder kind="empty">◇ {failureReason}</Placeholder>
              ) : !extraction || waitingForFailureReason ? (
                <Placeholder kind="loading">
                  ◆ reading extracted fields…
                </Placeholder>
              ) : extraction.unavailable ? (
                // Dim, not red, and it says why. Recon having no fields for a document is an ordinary
                // outcome -- an unmapped class, detail dropped to fit the row -- and dressing it as a
                // failure would send an operator looking for a broken console instead of a document
                // the pipeline classified as something reconciliation does not handle.
                <Placeholder kind="empty">
                  ◇ {extraction.unavailable}
                </Placeholder>
              ) : (
                <ExtractedFields sections={extraction.sections} />
              )}
            </div>
          </div>
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

/**
 * One extracted-field column: the class it belongs to and the field path within it.
 *
 * Keyed by class as well as field because the same field name means different things in two document
 * classes, and one column holding both would put a facility's paydown amount and a wire's amount under
 * the same header.
 */
interface FieldColumn {
  id: string;
  header: string;
  classification: string;
  field: string;
}

/** Class + field, as one column id. Safe against a field path that itself contains a separator. */
function fieldColumnId({
  classification,
  field,
}: {
  classification: string;
  field: string;
}): string {
  return `field:${classification} ${field}`;
}

/**
 * The columns implied by the extractions loaded so far: one per (document class, field) pair.
 *
 * Derived rather than declared for the same reason the queue's are — the fields are whatever the pinned
 * extraction configuration asks for, and that changes without this code changing. A field that no
 * loaded document carries gets no column, so the picker lists what is actually in front of the operator
 * rather than every field the configuration could ever produce.
 *
 * @param extractions - the extractions loaded so far, keyed by object key.
 * @returns the columns, grouped by class in first-seen order, fields in the extractor's own order.
 */
function deriveFieldColumns(
  extractions: Record<string, ExtractedSection[]>,
): FieldColumn[] {
  // Insertion-ordered: classes in the order documents were loaded, fields in the order the extractor
  // emitted them, which is the order its schema declares. Alphabetising would separate a total from the
  // line items above it that add up to it.
  const byClass = new Map<string, Set<string>>();
  for (const sections of Object.values(extractions)) {
    for (const s of sections) {
      const classification = s.classification ?? "unclassified";
      const fields = byClass.get(classification) ?? new Set<string>();
      for (const f of flattenExtractedFields(s.fields)) fields.add(f.field);
      // Scored fields the document carried no value for still earn a column: an operator sorting on one
      // wants to see WHICH documents left it blank, and a column that appeared only once some document
      // filled it in would hide exactly that.
      for (const r of s.confidences) fields.add(r.field);
      byClass.set(classification, fields);
    }
  }

  const out: FieldColumn[] = [];
  for (const [classification, fields] of byClass) {
    for (const field of fields) {
      out.push({
        id: fieldColumnId({ classification, field }),
        header: `${classification} · ${field}`,
        classification,
        field,
      });
    }
  }
  return out;
}

/**
 * One cell of an extracted-field column: the value and, under it, the confidence.
 *
 * Three distinct states, and telling them apart is the point. Nothing read for this document yet reads as
 * a middle dot; read and the field is absent reads as an em dash; read and present shows the value with
 * its score. Collapsing the first two would make "still arriving, or named under the table as unreadable"
 * look like "this document does not have that field".
 *
 * @param sections - the document's extraction, or undefined when it has not been loaded.
 * @param column - the column being rendered.
 */
function FieldCell({
  sections,
  column,
}: {
  sections: ExtractedSection[] | undefined;
  column: FieldColumn;
}) {
  if (!sections)
    return (
      <span
        className="rc-mono text-[12px] text-[var(--rc-ink-faint)]"
        title="Not read yet — either this row's fields are still arriving, or the document is one of those listed under the table as having no extracted fields to show."
      >
        ·
      </span>
    );

  const section = sections.find(
    (s) => (s.classification ?? "unclassified") === column.classification,
  );
  if (!section)
    return (
      <span
        className="rc-mono text-[12px] text-[var(--rc-ink-faint)]"
        title={`This document has no ${column.classification} section`}
      >
        —
      </span>
    );

  const value = flattenExtractedFields(section.fields).find(
    (f) => f.field === column.field,
  )?.value;
  const score = confidenceByField(section.confidences).get(column.field);
  const flagged = isBelowThreshold(score);
  const text = fieldText(value);
  return (
    <span className="block min-w-0" title={column.field}>
      <span
        className="rc-mono block truncate text-[12px]"
        style={{
          color: text === "—" ? "var(--rc-ink-faint)" : "var(--rc-ink)",
        }}
      >
        {text}
      </span>
      <span
        className="rc-mono rc-tnum block text-[10px]"
        style={{
          color: flagged ? "var(--rc-amber)" : "var(--rc-ink-faint)",
        }}
        title={
          score?.threshold === undefined || score?.threshold === null
            ? undefined
            : `threshold ${score.threshold.toFixed(2)}`
        }
      >
        {confidenceText(score?.confidence)}
      </span>
    </span>
  );
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
  // Seeded from the pins once they arrive — see the seeding effect. Starts empty so that nothing is being
  // applied that the operator cannot see in the box.
  const [filter, setFilter] = useState("");
  // True as soon as the operator touches the box, INCLUDING clearing it. The seed checks this so a pin
  // arriving late cannot overwrite what they typed, and so a cleared box stays cleared.
  const filterTouched = useRef(false);
  // Set the first time the pins are known, whether or not any were pinned, so the seed is a one-off.
  const seededPins = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [submissions, setSubmissions] = useState<SubmissionRow[] | null>(null);
  const [submissionsError, setSubmissionsError] = useState<string | null>(null);
  // Extractions, keyed by object key, and only for the documents on screen. One BatchGetItem over the
  // shown rows' notice rows, and each of those rows carries the document's whole extracted content, so it
  // is read a route page at a time as the rows arrive — see the auto-load effect below.
  const [extractions, setExtractions] = useState<
    Record<string, ExtractedSection[]>
  >({});
  const [extractionsFailed, setExtractionsFailed] = useState<
    Record<string, string>
  >({});
  // ⚠️ THE bound on the auto-load loop. Every key this tab has asked about, whatever came back — a hit, a
  // per-key failure, a whole-call failure, or nothing at all. Nothing here is ever requested twice, so the
  // loop cannot spin on a key the route answers for in neither map, and a failed batch is not retried
  // forever. A ref rather than state because it must not itself trigger the effect that reads it.
  const requestedKeys = useRef<Set<string>>(new Set());
  // Bumped by Apply, and in the auto-load effect's dependencies. Emptying the ledger above is invisible to
  // that effect on its own — a ref does not re-run anything — so this is what turns "the operator asked
  // again" into the one event allowed to retry a read that failed wholesale.
  const [fieldsRetry, setFieldsRetry] = useState(0);
  const [loadingFields, setLoadingFields] = useState(false);
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  // The pins, read from the Config tab's own list. Null until they arrive; an error here leaves the
  // table unfiltered rather than empty, with the reason said out loud — a filter that cannot be built
  // must not be indistinguishable from a filter that matched nothing.
  const [workflowTypes, setWorkflowTypes] = useState<WorkflowType[] | null>(
    null,
  );
  const [workflowTypesError, setWorkflowTypesError] = useState<string | null>(
    null,
  );
  // ⚠️ THE bound on the auto-pagination loop. Every continuation token already handed to `load`. A page
  // that fails leaves `nextToken` untouched, so without this the effect below would re-fire the moment
  // `loading` went false and retry the same token for as long as the tab stayed open. Cleared when Apply
  // starts a new window, which is the only time a token can legitimately be asked for again.
  const requestedTokens = useRef<Set<string>>(new Set());

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

  // Separate from `load`: this reads recon's upload audit table, and the date window above belongs to
  // the document listing. Tying the two together would make an upload disappear from this tab because
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

  // The window, in full, without a button. The list route pages a DynamoDB Query and there is no total,
  // so the old "Load more" was the operator's only way to find out whether what they were looking for was
  // simply on the next page — and the filter box only ever searched what had been fetched, which made a
  // missing document and an unfetched one look identical.
  //
  // Three things bound this, and it needs all three: no token means the index is exhausted; a token is
  // requested at most ONCE, so a page that failed (which leaves `nextToken` as it was) cannot be retried
  // when `loading` drops; and `load` writes the token it was given away before the next effect run reads
  // it. What is NOT a bound is `error` — a failure on page four must keep the three pages already on
  // screen and say so, not clear them.
  useEffect(() => {
    if (!nextToken || loading) return;
    if (requestedTokens.current.has(nextToken)) return;
    requestedTokens.current.add(nextToken);
    void load(nextToken);
  }, [nextToken, loading, load]);

  // The configuration versions this deployment pins, kept in the operator's own casing because they are
  // seeded into the filter box and read there. Retired types are included: a document processed last
  // month was processed against the version its type pinned then, and dropping retired pins would erase
  // it from this tab for no reason anyone could see.
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

  // The pins, put INTO the filter box, which is the whole of this tab's configuration restriction now.
  //
  // Three things this is careful about, and each of them is a way it has been got wrong:
  //
  //  - ONCE. `workflowTypes` is null while the read is in flight and an array afterwards — including the
  //    empty array, and including the empty array an error leaves behind. The guard flips on the first
  //    NON-NULL value, so a deployment that pins nothing seeds an empty box and is then left alone,
  //    rather than being re-seeded on every later render.
  //  - NEVER OVER THE OPERATOR. The pins take a moment to arrive and the box is usable immediately, so a
  //    naive seed would eat a term typed in the meantime. `filterTouched` is set by the box's own
  //    `onChange`, so anything typed wins.
  //  - NEVER BACK. Clearing the box is `onChange` too, so a cleared box is a touched box. Between that and
  //    the once-only guard, the seed cannot re-apply itself over the very gesture it exists to allow.
  useEffect(() => {
    if (filterTouched.current || seededPins.current) return;
    if (workflowTypes === null) return;
    seededPins.current = true;
    // Comma-separated, and `matchesFilterTerm` splits on the same separator, so several pins read as a
    // list and admit a row processed under any one of them.
    if (pinnedVersions.length > 0) setFilter(pinnedVersions.join(", "));
  }, [workflowTypes, pinnedVersions]);

  /**
   * The rows the filter box admits.
   *
   * ONE filter, where there used to be two. The configuration restriction ran invisibly ahead of the
   * operator's text, so the table was narrowed by a rule with no value on screen and no way off it; it is
   * now expressed AS the text, seeded above. Clearing the box therefore shows every loaded row — that is
   * the point of the change, not a side effect of it.
   *
   * The terms are unioned rather than intersected: several pinned versions arrive as one comma-separated
   * string, and a row processed under either one is recon's own.
   *
   * Still over the rows already loaded, not a server-side search — the list route pages a DynamoDB Query
   * over a time index, which has nothing to search a file name with. That is now much less of a trap than
   * it was, because the pages no longer wait for a button.
   */
  const shown = useMemo(() => {
    if (!rows) return [];
    const terms = filter
      .toLowerCase()
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    // An empty box is EVERY loaded row, other deployments' configurations included. A reader who clears
    // the filter has asked to see what was being kept from them, and has to actually get it.
    if (terms.length === 0) return rows;
    return rows.filter((row) =>
      terms.some((term) => matchesFilterTerm({ row, term, pinnedLower })),
    );
  }, [rows, filter, pinnedLower]);

  /**
   * The keys of loaded rows that never became a notice — a tracking-only row, carrying the reason recon
   * mapped nothing out of the document.
   *
   * Read off `notice_failure_reason`, which the list route already returns on every row (see
   * `toIdpDocument`), rather than by matching the sentence the extractions read hands back: the two
   * would then have to be edited together, and a reworded sentence would silently re-admit these rows.
   *
   * Built from every LOADED row and not from `shown`, so typing in the filter box cannot make a row
   * reappear in the block below by taking it out of the set that excludes it.
   */
  const trackingOnlyKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows ?? []) {
      if ((r.notice_failure_reason ?? "") !== "" && r.ObjectKey)
        keys.add(r.ObjectKey);
    }
    return keys;
  }, [rows]);

  /**
   * The failed keys worth warning about: everything except a tracking-only row.
   *
   * A tracking-only row has no extracted fields because recon mapped no notice from the document — an
   * ordinary outcome the pipeline reached and recorded, not a read that failed. Its reason is already on
   * the row's own detail panel under "Extracted fields", so listing it here duplicated that and dressed
   * it as a warning. What is LEFT is the set a reader genuinely cannot explain from the row: a notice
   * whose `idp_sections` were dropped to fit DynamoDB's item limit, a key the table did not answer for,
   * and a document recon holds no notice for at all. Those are why a field column shows a middle dot.
   *
   * One list, used for both the count and the entries, so the summary line cannot claim a number the
   * block does not list.
   */
  const unexplainedFailures = useMemo(
    () =>
      Object.entries(extractionsFailed).filter(
        ([key]) => !trackingOnlyKeys.has(key),
      ),
    [extractionsFailed, trackingOnlyKeys],
  );

  /** Shown rows whose extraction has not been read yet — what the effect below will fetch. */
  const unloadedKeys = useMemo(
    () =>
      shown
        .map((r) => r.ObjectKey)
        .filter((k): k is string => Boolean(k))
        .filter((k) => !(k in extractions) && !(k in extractionsFailed)),
    [shown, extractions, extractionsFailed],
  );

  /**
   * Read the extractions for a batch of keys.
   *
   * Takes its keys rather than reading `unloadedKeys` itself, so the caller can subtract the keys already
   * asked about — the identity that bounds the loop. Marking happens BEFORE the first `await`, so two
   * renders in a row cannot both decide the same key is unrequested.
   *
   * @param keys - object keys to read, at most one route page of them.
   */
  const loadFields = useCallback(async (keys: string[]): Promise<void> => {
    if (keys.length === 0) return;
    for (const k of keys) requestedKeys.current.add(k);
    setLoadingFields(true);
    // ⚠️ A previous failure is NOT cleared here. When a press cleared it, the next press was the operator's
    // own decision to move on; the batches now go out on their own, so clearing would erase the only
    // explanation of a page of middle dots the moment the following page happened to succeed. Apply clears
    // it, which is also what asks for the failed read to be tried again.
    try {
      const res = await getIdpExtractions(keys);
      // Merged, not replaced: an earlier page's fields are already on screen, and replacing would empty
      // every column the operator is currently reading.
      setExtractions((prev) => ({ ...prev, ...res.extractions }));
      setExtractionsFailed((prev) => ({ ...prev, ...res.failed }));
    } catch (e) {
      setFieldsError(String(e));
    } finally {
      setLoadingFields(false);
    }
  }, []);

  // The extracted fields, for whatever is on screen, without a button. They are not in the rows this table
  // already has — they are a separate read of each document's notice row — so before this the per-field
  // columns were empty until somebody knew to press for them, which is a thing nobody discovers.
  //
  // ⚠️ What stops this spinning, given that its own result is what changes its input:
  //
  //  - A key is added to `requestedKeys` before the request goes out and never leaves, so the same key is
  //    never asked about twice. That holds even if the route answers for a key in NEITHER map — which
  //    would otherwise leave it in `unloadedKeys` forever and re-fire this on every render.
  //  - The same ref is why a whole-call failure is not retried: the batch was marked on the way out. The
  //    error is shown once and later pages still get their turn.
  //  - `loadingFields` serialises the calls, so a window whose pages keep arriving queues its batches
  //    behind each other instead of firing several at once, and each stays under the route's ceiling.
  useEffect(() => {
    if (loadingFields) return;
    // One route page at a time — the route refuses more than 100 keys, and it is DynamoDB's BatchGetItem
    // limit, so a full page is one round trip.
    const batch = unloadedKeys
      .filter((k) => !requestedKeys.current.has(k))
      .slice(0, 100);
    if (batch.length === 0) return;
    void loadFields(batch);
    // `fieldsRetry` only ever moves on an Apply click, so it widens the loop by exactly one pass per
    // gesture and cannot itself drive one.
  }, [unloadedKeys, loadingFields, loadFields, fieldsRetry]);

  // Rebuilt only when an extraction actually arrives, so the identity is stable — `DataTable` re-reads
  // its stored layout whenever its column set changes, and this set runs to dozens of columns.
  const fieldColumns = useMemo(
    () => deriveFieldColumns(extractions),
    [extractions],
  );

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
        id: "started",
        header: "Started",
        cell: (d) => (
          <StartedTime
            iso={d.InitialEventTime}
            approximate={d.idp_started_at_approximate === true}
          />
        ),
        // Sorted on the raw timestamp, not the formatted string, so ordering does not depend on locale.
        // A derived timestamp sorts alongside the real ones -- there is nowhere honest to put it
        // instead -- which is why every one of them carries a visible marker in the cell.
        sortValue: (d) => d.InitialEventTime ?? null,
      },
      {
        id: "config_version",
        header: "Config version",
        cell: (d) => <ConfigVersionCell version={d.ConfigVersion} />,
        // Null sorts as null, as everywhere else in this table: the rows recon has no version for group
        // together rather than sorting under whatever placeholder the cell happens to draw.
        sortValue: (d) => d.ConfigVersion ?? null,
      },
      // ⚠️ There is no `ObjectStatus` column, and that is deliberate rather than an omission. Recon still
      // RECORDS it — it is on the wire contract and in `idp_tracking` — but the hook fires while the
      // pipeline is still evaluating, so every row in the live table reads `EVALUATING` and always will.
      // A column with one value on every row tells a reader nothing, and sitting beside two TERMINAL
      // statuses (this one, `SUCCEEDED`, and Eval's `COMPLETED`) it read as three columns contradicting
      // each other on every row. Do not add it back: the fix for wanting a live status is a later read of
      // the pipeline, not displaying a snapshot taken before it finished.
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
        // A node so the caveat can be a tooltip: the header is one narrow word and the caveat is a
        // sentence — this counts only attributes the extractor READ A VALUE FOR, which is why it can be
        // smaller than the list of flags in the detail panel. Same trade as the Eval column: the Columns
        // picker falls back to the column id for a non-string header, so it reads as "alerts" there.
        header: <span title={EXTRACTED_ALERTS_TITLE}>Alerts</span>,
        defaultHidden: true,
        cell: (d) => (
          <span
            className="rc-mono text-[12px]"
            title={EXTRACTED_ALERTS_TITLE}
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
        // A node so the caveat can be a tooltip on the label: this is the pipeline's status at the
        // moment recon's hook ran, and the hook runs while the pipeline is still evaluating. The cost
        // of a non-string header is that the Columns picker falls back to the column id for its
        // label — see `labelFor` in `DataTable` — which reads as "evaluation" and is close enough.
        // No `≈` here: that marker means "derived timestamp" in the Started column and overloading it
        // with a second meaning would cost it the first one.
        header: <span title={EVALUATION_SNAPSHOT_TITLE}>Eval</span>,
        defaultHidden: true,
        cell: (d) => (
          <span title={EVALUATION_SNAPSHOT_TITLE}>
            <DocStatus status={d.EvaluationStatus} />
          </span>
        ),
        sortValue: (d) => d.EvaluationStatus ?? null,
      },
      // --- What the extractor read out of each document ---
      // One column per (class, field) pair among the extractions loaded so far, all hidden by default:
      // a single notice class runs to seventeen fields and a mixed window to several times that. They
      // appear as the reads land — the values are not in the rows this table already has, they are a
      // separate read of each document's notice row, so the set grows page by page.
      ...fieldColumns.map((f) => ({
        id: f.id,
        header: f.header,
        width: "minmax(0,1.3fr)",
        defaultHidden: true,
        sortValue: (d: IdpDocument) => {
          const sections = d.ObjectKey ? extractions[d.ObjectKey] : undefined;
          if (!sections) return null;
          const section = sections.find(
            (s) => (s.classification ?? "unclassified") === f.classification,
          );
          if (!section) return null;
          const value = flattenExtractedFields(section.fields).find(
            (x) => x.field === f.field,
          )?.value;
          if (value === null || value === undefined || value === "")
            return null;
          if (typeof value === "number") return value;
          const text = String(value);
          // Amounts arrive as strings, so they sort as numbers when they are ones — a text compare would
          // put "9,000.00" above "10,000.00", which is the wrong answer for the columns most worth
          // sorting. A comma is stripped first because the extractor keeps the document's own grouping.
          const asNumber = Number(text.replace(/,/g, ""));
          return Number.isFinite(asNumber) && text.trim() !== ""
            ? asNumber
            : text;
        },
        cell: (d: IdpDocument) => (
          <FieldCell
            sections={d.ObjectKey ? extractions[d.ObjectKey] : undefined}
            column={f}
          />
        ),
      })),
    ],
    [fieldColumns, extractions],
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
            <Eyebrow>Read from recon&rsquo;s notice store</Eyebrow>
            <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
              Documents
            </h1>
          </div>
          {/* Hidden from a non-admin, and that is presentation only. The route runs
              `requireReconAdmin` on every request and 403s regardless of what the browser rendered --
              this just avoids offering a button whose only outcome is a 403. `isAdmin` comes from
              the shell's `/api/me` (via `useReconSubject`), the same signal the nav uses to gate the
              Config tab. */}
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
        {/* Four words, at the user's request. The legend this paragraph used to carry for the `≈` and
            `?` markers is NOT lost: each marker carries the same sentence as its own `title`, on the
            glyph itself — see `APPROXIMATE_START_TITLE` and `UNKNOWN_CONFIG_TITLE`. Those tooltips are
            now the only explanation either marker has, so do not remove one on the grounds that it
            duplicates the header. */}
        <p className="rc-mono mt-3 max-w-3xl text-[12px] leading-relaxed text-[var(--rc-ink-faint)]">
          record of extraction pipeline
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
              // A new window is the one time a continuation token may legitimately be handed out again.
              requestedTokens.current.clear();
              // And the one way to ask for a read that failed WHOLESALE to be tried again — the effects
              // never retry on their own, by design. Keys that failed on their own terms are still in
              // `extractionsFailed`, which keeps them out of the unloaded set, so this retries only the
              // batches that never got an answer at all.
              requestedKeys.current.clear();
              setFieldsError(null);
              setFieldsRetry((n) => n + 1);
              void load(null);
            }}
          >
            {loading ? "Loading…" : "Apply"}
          </button>
          <label className="ml-auto block min-w-[220px] flex-1">
            {/* The label says CLEAR, because clearing is the gesture that needs advertising: the box
                arrives holding this deployment's pinned configuration versions, and emptying it is how an
                operator sees the rows those versions were keeping off the table. */}
            <span className="rc-eyebrow">
              Filter loaded rows — clear to see all
            </span>
            <input
              className={`${INPUT} mt-1`}
              placeholder="file name, config version, workflow status"
              value={filter}
              // Every keystroke marks the box touched, INCLUDING the one that empties it, which is what
              // stops the pin seed re-applying itself over a deliberate clear.
              onChange={(e) => {
                filterTouched.current = true;
                setFilter(e.target.value);
              }}
            />
          </label>
        </div>
        {/* The one thing left under the filter row, and only when it goes wrong: with the pins unreadable
            nothing seeds the box, so the table silently shows every loaded row — including other
            deployments' configurations — and this is the ONLY signal of that anywhere in the app. */}
        {workflowTypesError && (
          <p
            className="rc-mono mt-3 text-[11px] leading-relaxed"
            style={{ color: "var(--rc-amber)" }}
          >
            Could not read the configured workflow types — {workflowTypesError}.
            The filter could not be seeded with this deployment&rsquo;s pinned
            configuration versions, so every loaded row is shown, including
            other deployments&rsquo; configurations.
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
                : // The escape hatch is named, because the filter arrives with a value in it that the
                  // operator did not type: "nothing matches" without "and here is how to see the rest"
                  // is the state this whole change exists to remove.
                  `◇ none of the ${rows.length} loaded rows match the filter — clear it to see every one of them`}
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
          {/* ⚠️ There is no strip of buttons here any more, and it is not an omission. "Load more", "Load
              extracted fields" and the count line beside them are gone, and their WORK is not: the
              pagination effect walks the continuation tokens to the end of the window on its own, and the
              auto-load effect reads each page's extracted fields as the rows arrive. Do not put a button
              back to restore a capability that is already running — see the bounds documented on both
              effects before touching either. What is left below are the two error surfaces, which were
              never part of the strip.

              The whole call failed — a misconfigured table name, or credentials this deployment does not
              have. A key that failed on its own is reported below instead, because those are two
              different conversations. */}
          {fieldsError && (
            <p
              className="rc-mono text-[11px] leading-relaxed"
              style={{ color: "var(--rc-amber)" }}
            >
              Could not read extracted fields — {fieldsError}
            </p>
          )}
          {/* Named, not silently missing. A document recon holds no notice for — most often another
              deployment's — shows middle dots in every field column, and without this line that is
              indistinguishable from a read that has not happened yet. The reasons here are ordinary
              answers, so the block is a closed details element rather than a banner.
              ⚠️ `unexplainedFailures`, not `extractionsFailed`: a tracking-only row is left out
              entirely, because its reason is already on its own detail panel and it explains an outcome
              rather than a failure. Rendered only when something is left — an empty `<details>` reads as
              a warning with the detail withheld. */}
          {unexplainedFailures.length > 0 && (
            <details className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
              {/* "with no extracted fields to show" rather than "whose fields could not be read":
                  reading is only one of the reasons listed underneath. A row dropped to fit the item
                  limit was read and then trimmed. The count comes off the same list the entries do, so
                  the summary cannot promise more than it lists. */}
              <summary className="cursor-pointer">
                {unexplainedFailures.length} document
                {unexplainedFailures.length === 1 ? "" : "s"} with no extracted
                fields to show
              </summary>
              <div className="mt-2 space-y-1">
                {unexplainedFailures.map(([key, reason]) => (
                  <p key={key} style={{ color: "var(--rc-amber)" }}>
                    {basename(key)} — {reason}
                  </p>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      <Panel className="rc-rise space-y-3 p-4">
        <h2 className="rc-display text-[20px] font-black text-[var(--rc-ink)]">
          Recent uploads
        </h2>
        {/* Recon's own audit record of every upload it accepted or refused, including the reasons
            below. Overlaps the table above rather than complementing it — an extraction upload made
            here appears in both — so nothing in this panel claims otherwise. */}
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

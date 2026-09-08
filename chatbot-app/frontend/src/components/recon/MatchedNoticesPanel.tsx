"use client";

import { useState } from "react";
import type { ReasoningStep } from "@/lib/reconApi";
import { Eyebrow, Panel } from "@/components/recon/ui";
import { FieldValue, humanizeKey } from "@/components/recon/IdpDocumentPanel";
import SourceDocumentPreview from "@/components/recon/SourceDocumentPreview";

// The counterparty notices the investigation actually matched, read back out of the trace.
//
// There is no BFF route behind this and deliberately so: `search_notices` already records its full
// result set in the trace as JSON, so the rows are on the case payload the page has fetched. Adding a
// route that re-read the notices table would show the notice as it is NOW, not as the agent saw it —
// and the panel sits under the evidence table, whose whole claim is what the agent had in front of it.
//
// It answers the question the Evidence Score raises and cannot itself answer. Three of the score's
// steps (`fund_alias_match`, `asset_identity_match`, `fund_level_amount_available`) are answered from a
// notice, so when they report "returned nothing" the next question is always whether a notice was found
// at all. An empty match is therefore rendered, not hidden: it is the reason for the score.

/** One row as `search_notices` returns it. Every field is optional — the tool omits what a notice class does not carry. */
interface NoticeRow {
  notice_id?: string;
  notice_class?: string;
  notice_date?: string;
  counterparty?: string;
  fund?: string;
  facility?: string;
  reference?: string;
  amount?: number;
  currency?: string;
  extraction_confidence?: number;
  confidence_alert_count?: number;
  source_document?: string;
  fields_unavailable?: string[];
  [key: string]: unknown;
}

/** What the trace records for the `search_notices` calls on one case. */
interface NoticeSearchOutcome {
  /** Whether any `search_notices` call is present at all. False on a harness-produced trace. */
  searched: boolean;
  /** Matched notices, de-duplicated by `notice_id`, in the order the tool first returned them. */
  notices: NoticeRow[];
  /** The attributes the tool reports it matched on, merged across calls. */
  matchedOn: string[];
  /** A tool-level error string, when a call failed rather than returning rows. */
  error: string | null;
}

/**
 * Field order for the expanded view. Listed rather than derived from `Object.keys` so the reading
 * order is stable across notice classes: two notices side by side must put the amount in the same
 * place, and key order in the tool's JSON is not a contract.
 *
 * Anything the tool returns that is NOT listed here is still rendered, after these — a new field
 * added upstream must not silently vanish from the panel.
 */
const FIELD_ORDER: readonly string[] = [
  "notice_id",
  "notice_class",
  "notice_date",
  "counterparty",
  "fund",
  "facility",
  "reference",
  "amount",
  "currency",
  "source_document",
  "extraction_confidence",
  "confidence_alert_count",
  "fields_unavailable",
];

/**
 * Pull every notice `search_notices` returned out of a case's trace.
 *
 * Defensive about the payload on purpose: `tool_output` is a plain string, and a denied or failed
 * tool call puts an `{"error": ...}` object there instead of rows. A parse failure must not take the
 * page down, so it is treated as "this call contributed nothing".
 *
 * @param steps - the case's reasoning steps; may be undefined on a case with no trace.
 * @returns what the trace says about notice matching.
 */
export function noticesFromTrace(
  steps: readonly ReasoningStep[] | undefined,
): NoticeSearchOutcome {
  const calls = (steps ?? []).filter(
    (s) => s.kind === "tool_call" && s.tool === "search_notices",
  );
  const notices: NoticeRow[] = [];
  const matchedOn = new Set<string>();
  const seen = new Set<string>();
  let error: string | null = null;

  for (const call of calls) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.tool_output ?? "");
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const body = parsed as {
      rows?: unknown;
      matched_on?: unknown;
      error?: unknown;
    };
    if (typeof body.error === "string" && !error) error = body.error;
    if (Array.isArray(body.matched_on))
      for (const m of body.matched_on)
        if (typeof m === "string") matchedOn.add(m);
    if (!Array.isArray(body.rows)) continue;
    for (const row of body.rows) {
      if (typeof row !== "object" || row === null) continue;
      const notice = row as NoticeRow;
      // De-duplicated by id because the agent may call search_notices more than once while
      // narrowing, and the same notice coming back twice is one piece of evidence, not two.
      // A row with no id cannot be de-duplicated, so it is kept as-is rather than dropped.
      const key = notice.notice_id ?? "";
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      notices.push(notice);
    }
  }

  return {
    searched: calls.length > 0,
    notices,
    matchedOn: [...matchedOn],
    error,
  };
}

/**
 * Format a notice's amount for the collapsed summary line.
 *
 * @param row - the notice row.
 * @returns the amount with its currency, or null when the notice carries no amount.
 */
function amountLabel(row: NoticeRow): string | null {
  if (typeof row.amount !== "number") return null;
  const formatted = row.amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return row.currency ? `${row.currency} ${formatted}` : formatted;
}

/**
 * One notice: a summary line that expands into every field the tool returned.
 *
 * @param row - the notice row.
 * @param index - position in the list, used for the fallback key and label.
 */
function NoticeRowView({ row, index }: { row: NoticeRow; index: number }) {
  const [open, setOpen] = useState(false);
  const label = row.notice_id ?? `notice ${index + 1}`;
  const amount = amountLabel(row);
  const alerts = row.confidence_alert_count ?? 0;
  // `source_document` IS the pipeline's object key for an IDP-ingested notice -- the hook writes
  // `source_document=object_key` (backend/idp_hook/mapper.py). A SEEDED notice carries a friendly
  // filename instead, which the pipeline has no record of; that case is not special-cased here on
  // purpose. The source route resolves every key through the pipeline's own `getDocument` before
  // reading a byte, so an unresolvable one comes back as a 404 that names it, and the preview shows
  // that sentence. Guessing here ("does this look like a key?") would either hide a real document or
  // invent a reason it is missing.
  const sourceKey = (row.source_document ?? "").trim() || null;

  // Listed keys first in their declared order, then anything else the tool returned, so an upstream
  // addition shows up instead of disappearing.
  const keys = [
    ...FIELD_ORDER.filter((k) => k in row),
    ...Object.keys(row).filter((k) => !FIELD_ORDER.includes(k)),
  ];

  return (
    <div className="border-t border-[var(--rc-line-soft)] first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--rc-line-soft)]/30"
      >
        <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          {open ? "▾" : "▸"}
        </span>
        <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
          {label}
        </span>
        {row.notice_class && (
          <span className="rc-mono text-[11px] text-[var(--rc-cyan)]">
            {row.notice_class}
          </span>
        )}
        {row.notice_date && (
          <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            {row.notice_date}
          </span>
        )}
        {amount && (
          <span className="rc-mono text-[11px] text-[var(--rc-ink-dim)]">
            {amount}
          </span>
        )}
        {/* Surfaced on the collapsed row because it is a reason to distrust the row's own numbers,
            and a reader deciding whether to expand needs it before they expand. */}
        {alerts > 0 && (
          <span
            className="rc-mono text-[11px]"
            style={{ color: "var(--rc-amber)" }}
            title={`${alerts} extracted field(s) scored below their confidence threshold.`}
          >
            {alerts} alert{alerts === 1 ? "" : "s"}
          </span>
        )}
        <span className="ml-auto truncate rc-mono text-[11px] text-[var(--rc-ink-faint)]">
          {row.counterparty ?? ""}
        </span>
      </button>

      {open && (
        // Fields and the document they came from, side by side on a wide screen and stacked on a
        // narrow one. Reading an extracted value without the page it was read off is most of the
        // analyst's doubt: "is `amount` 9,640.18?" is answered by the notice, not by the row.
        <div className="grid gap-5 px-3 pb-4 pl-9 xl:grid-cols-2">
          <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-1.5 self-start">
            {keys.map((k) => (
              <div key={k} className="col-span-2 grid grid-cols-subgrid">
                <dt className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
                  {humanizeKey(k)}
                </dt>
                <dd className="min-w-0 break-words text-[12px] text-[var(--rc-ink-dim)]">
                  <FieldValue value={row[k]} />
                </dd>
              </div>
            ))}
          </dl>

          <div className="min-w-0">
            <div
              className="rc-eyebrow mb-2"
              title="The document these values were extracted from, streamed from the pipeline's input bucket."
            >
              Source document
            </div>
            {sourceKey ? (
              <SourceDocumentPreview objectKey={sourceKey} />
            ) : (
              <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
                This notice records no source document, so there is nothing to
                show beside it.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The notices this case's investigation matched, listed under the evidence table.
 *
 * Renders nothing when the trace records no `search_notices` call at all — that is normal for a
 * harness-produced case, and an empty panel claiming "no notices matched" would misreport a search
 * that never happened as a search that found nothing.
 *
 * @param steps - the case's reasoning steps.
 */
export function MatchedNoticesPanel({
  steps,
}: {
  steps: readonly ReasoningStep[] | undefined;
}) {
  const { searched, notices, matchedOn, error } = noticesFromTrace(steps);
  if (!searched) return null;

  return (
    <Panel className="rc-rise min-w-0 p-6">
      <Eyebrow title="Counterparty notices the investigation matched, as search_notices returned them. Click one to see every field the extraction reported for it.">
        Matched Notices{notices.length > 0 ? ` (${notices.length})` : ""}
      </Eyebrow>

      <div className="mt-4">
        {error ? (
          <p
            className="rc-mono text-[12px]"
            style={{ color: "var(--rc-amber)" }}
          >
            The notice search failed, so this case was investigated without
            notice evidence — {error}
          </p>
        ) : notices.length === 0 ? (
          <p className="rc-mono text-[12px] text-[var(--rc-ink-faint)]">
            search_notices ran and matched no notices
            {matchedOn.length > 0
              ? ` (matched on: ${matchedOn.join(", ")})`
              : ""}
            . Any evidence step above that reads from a notice therefore
            returned nothing.
          </p>
        ) : (
          <>
            <div className="overflow-hidden rounded border border-[var(--rc-line-soft)]">
              {notices.map((row, i) => (
                <NoticeRowView
                  key={row.notice_id ?? `row-${i}`}
                  row={row}
                  index={i}
                />
              ))}
            </div>
            {matchedOn.length > 0 && (
              <p className="rc-mono mt-2 text-[11px] text-[var(--rc-ink-faint)]">
                matched on: {matchedOn.join(", ")}
              </p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
}

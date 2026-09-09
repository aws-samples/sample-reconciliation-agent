"use client";

import { humanizeKey } from "@/components/recon/IdpDocumentPanel";
import {
  confidenceByField,
  confidenceText,
  fieldText,
  flattenExtractedFields,
  isBelowThreshold,
} from "@/lib/idpFields";
import type { ExtractedSection } from "@/lib/reconApi";

// Every field the pipeline read out of a document, each with the confidence it was read at. The
// Documents tab used to show only the tracking record, which carries a count of low-confidence
// attributes and the names of the ones that tripped -- so an operator could see that three fields were
// doubtful and never what any of the other twenty said.
//
// Rendered as a flat list of paths rather than as a nested tree, and that is the whole point: a
// confidence belongs to a LEAF (`AccrualLineItems[1].Amount`, not `AccrualLineItems`), so a nested
// renderer would have nowhere to put the number that matters. The path notation is the join key
// between a value and its score -- see `src/lib/idpFields.ts`.
//
// A field IDP scored but extracted nothing for keeps its row and reads as an em dash. Dropping those
// would make the panel a list of what happened to work, and "the schema has a Fax field and this notice
// did not carry one" is the answer to a question operators actually ask.

/**
 * How far a confidence bar fills, as a percentage string.
 *
 * @param confidence - the score in [0, 1].
 * @returns a CSS width.
 */
function barWidth(confidence: number): string {
  return `${Math.max(0, Math.min(1, confidence)) * 100}%`;
}

/**
 * One field: its name, its value, and how sure the extractor was.
 *
 * @param field - the field path as IDP scores it.
 * @param value - the extracted value, or an absence.
 * @param confidence - the score, or null when IDP recorded none for this field.
 * @param threshold - the field's own threshold, for the hover text.
 * @param flagged - true when the field is below its own threshold.
 */
function FieldRow({
  field,
  value,
  confidence,
  threshold,
  flagged,
}: {
  field: string;
  value: unknown;
  confidence: number | null;
  threshold: number | null;
  flagged: boolean;
}) {
  const text = fieldText(value);
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] items-baseline gap-3 border-b border-[var(--rc-line-soft)] py-1.5 last:border-0">
      <span
        className="rc-mono break-words text-[11px] text-[var(--rc-ink-faint)]"
        title={field}
      >
        {humanizeKey(field)}
      </span>
      <span
        className="rc-mono break-words text-[12px]"
        style={{
          color: text === "—" ? "var(--rc-ink-faint)" : "var(--rc-ink)",
        }}
      >
        {text}
      </span>
      {/* The number and a bar for it. The bar is what makes a column of scores scannable -- 0.62 among
          twenty 0.99s is easy to miss as text and impossible to miss as a short bar. */}
      <span
        className="flex items-center gap-2"
        title={
          threshold === null
            ? confidence === null
              ? "the extractor recorded no confidence for this field"
              : "the extractor recorded no threshold for this field"
            : `threshold ${threshold.toFixed(2)}`
        }
      >
        <span
          className="rc-mono rc-tnum text-[11px]"
          style={{
            color: flagged ? "var(--rc-amber)" : "var(--rc-ink-dim)",
          }}
        >
          {confidenceText(confidence)}
        </span>
        <span className="block h-1 w-10 bg-[var(--rc-line)]">
          {confidence !== null && (
            <span
              className="block h-full"
              style={{
                width: barWidth(confidence),
                background: flagged ? "var(--rc-amber)" : "var(--rc-cyan)",
              }}
            />
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * Every extracted field of every section, with confidences.
 *
 * @param sections - the sections as the extraction route returned them.
 */
export function ExtractedFields({
  sections,
}: {
  sections: ExtractedSection[];
}) {
  if (sections.length === 0)
    return (
      <p className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">
        ◇ the pipeline recorded no sections for this document, so there is
        nothing extracted to show
      </p>
    );

  return (
    <div className="space-y-3">
      {sections.map((s, i) => {
        const scores = confidenceByField(s.confidences);
        const fields = flattenExtractedFields(s.fields);
        // Fields IDP scored but extracted nothing for. They have no leaf in `inference_result` at all,
        // so they are absent from `fields` and would otherwise vanish from the panel — and "the schema
        // asked for a Fax number, this notice carried none" is a different answer from "nobody asked".
        const present = new Set(fields.map((f) => f.field));
        const notInDocument = s.confidences.filter(
          (r) => !r.extracted && !present.has(r.field),
        );
        return (
          <div
            key={s.section_id ?? i}
            className="border border-[var(--rc-line)] p-3"
          >
            <div className="rc-mono flex flex-wrap items-baseline gap-x-3 text-[12px] text-[var(--rc-ink)]">
              <span>{s.classification ?? "unclassified"}</span>
              <span className="text-[var(--rc-ink-dim)]">
                pages {s.page_ids.join(", ") || "—"}
              </span>
              {/* The aggregate the platform itself acts on: this is the number the hook stores as a
                  notice's extraction confidence, computed by the same rules. */}
              <span className="text-[var(--rc-ink-dim)]">
                mean{" "}
                {s.mean_confidence === null
                  ? "—"
                  : s.mean_confidence.toFixed(3)}
              </span>
              <span
                style={{
                  color: s.alert_count
                    ? "var(--rc-amber)"
                    : "var(--rc-ink-faint)",
                }}
              >
                {s.alert_count} below threshold
              </span>
              <span className="text-[var(--rc-ink-faint)]">
                {fields.length} field{fields.length === 1 ? "" : "s"}
              </span>
            </div>

            {s.error ? (
              // Named, not blank. A section whose result JSON has aged out of the pipeline's storage is
              // a different thing from a section that produced no fields, and only one of the two is
              // worth chasing.
              <p
                className="rc-mono mt-2 text-[11px] leading-relaxed"
                style={{ color: "var(--rc-amber)" }}
              >
                Could not read what was extracted from this section — {s.error}
              </p>
            ) : fields.length === 0 ? (
              <p className="rc-mono mt-2 text-[11px] text-[var(--rc-ink-dim)]">
                ◇ the extractor returned no fields for this section
              </p>
            ) : (
              <div className="mt-2">
                <div className="rc-eyebrow grid grid-cols-[1fr_1fr_auto] gap-3 border-b border-[var(--rc-line)] pb-1">
                  <span>Field</span>
                  <span>Value</span>
                  <span>Confidence</span>
                </div>
                {fields.map((f) => {
                  const score = scores.get(f.field);
                  return (
                    <FieldRow
                      key={f.field}
                      field={f.field}
                      value={f.value}
                      confidence={score ? score.confidence : null}
                      threshold={score ? score.threshold : null}
                      flagged={isBelowThreshold(score)}
                    />
                  );
                })}
                {notInDocument.length > 0 && (
                  <p className="rc-mono mt-2 text-[11px] leading-relaxed text-[var(--rc-ink-faint)]">
                    Asked for but not present in this document:{" "}
                    {notInDocument.map((r) => humanizeKey(r.field)).join(", ")}.
                    These are excluded from the mean and from the
                    below-threshold count.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

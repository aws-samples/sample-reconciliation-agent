/**
 * Turning one section's extracted values into a flat, per-field list the browser can render.
 *
 * Separate from `src/lib/noticeExtraction.ts` on purpose: that module talks to DynamoDB and is
 * server-only, and importing it from a component would pull the AWS client into the browser bundle.
 * Everything here is pure, so both the detail panel and the table's column derivation use it and
 * cannot disagree about what a field is called.
 *
 * The path notation matches the one `backend/idp_hook/explainability.py` builds for its confidence
 * records — `amount`, `AccrualLineItems[1].Amount` — because that is the join key between a value and
 * its confidence. The two must be kept in step across the language boundary, and
 * `__tests__/lib/idpFields.test.ts` pins this side against a fixture in the shape that module emits.
 */

import type { ExtractedFieldConfidence } from "@/lib/reconApi";

/** One leaf of `inference_result`: the path IDP scores it under, and the value itself. */
export interface ExtractedField {
  field: string;
  value: unknown;
}

/**
 * Whether a value is a leaf for display purposes.
 *
 * An empty object or empty array is a leaf even though it is technically a container: descending into
 * it yields nothing, and a field that vanished from the panel because IDP returned `{}` for it would
 * read as a field the schema never had.
 *
 * @param value - the value at this position.
 * @returns true when the value should be rendered rather than descended into.
 */
function isLeaf(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return true;
  return Object.keys(value as object).length === 0;
}

/**
 * Flatten `inference_result` into one entry per leaf, depth-first, in IDP's own key order.
 *
 * Key order is not sorted anywhere in this path: IDP emits the fields in the order its extraction
 * schema declares them, which is the order a reviewer reads them off the page. Alphabetising would put
 * a total above the line items that add up to it.
 *
 * @param fields - the section's `inference_result`.
 * @returns one entry per leaf value, with its dotted/bracketed path.
 */
export function flattenExtractedFields(
  fields: Record<string, unknown>,
): ExtractedField[] {
  const out: ExtractedField[] = [];
  const walk = ({ value, path }: { value: unknown; path: string }): void => {
    if (isLeaf(value)) {
      // The empty root of a section that produced nothing is not a field.
      if (path) out.push({ field: path, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        walk({ value: child, path: `${path}[${index}]` }),
      );
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      walk({ value: child, path: path ? `${path}.${key}` : key });
  };
  walk({ value: fields, path: "" });
  return out;
}

/**
 * Index a section's confidence records by field path.
 *
 * @param records - the section's confidence records.
 * @returns a lookup from field path to record.
 */
export function confidenceByField(
  records: ExtractedFieldConfidence[],
): Map<string, ExtractedFieldConfidence> {
  return new Map(records.map((r) => [r.field, r]));
}

/**
 * A value as a single line of text for a table cell.
 *
 * Structures are rendered as compact JSON rather than dropped. A cell is the wrong place to read one,
 * but `[object Object]` is worse, and the detail panel is one click away — see `flattenExtractedFields`,
 * which means a structure only reaches here if IDP returned an empty one.
 *
 * @param value - the leaf value.
 * @returns the text to show, or an em dash for an absence.
 */
export function fieldText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * A confidence as two decimals, or a marker for an unscored field.
 *
 * @param confidence - the score, or null/undefined when IDP recorded none for this field.
 * @returns the text to show.
 */
export function confidenceText(confidence: number | null | undefined): string {
  return confidence === null || confidence === undefined
    ? "—"
    : confidence.toFixed(2);
}

/**
 * Whether a field should be flagged in the UI.
 *
 * Below its OWN threshold, and only when IDP actually extracted a value: thresholds are per-field
 * (0.8 and 0.9 both occur live) and an absent optional field IDP scored 0.0 is not a data-quality
 * problem. Same rule as `below_threshold_count` in `backend/idp_hook/explainability.py`, which is what
 * produced the count shown above this row, so a flagged row and that count cannot contradict.
 *
 * @param record - the field's confidence record, or undefined when it has none.
 * @returns true when the field is below threshold.
 */
export function isBelowThreshold(
  record: ExtractedFieldConfidence | undefined,
): boolean {
  if (!record || !record.extracted || record.threshold === null) return false;
  return record.confidence < record.threshold;
}

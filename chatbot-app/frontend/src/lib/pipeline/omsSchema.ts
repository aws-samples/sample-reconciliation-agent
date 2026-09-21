// OMS staging-CSV schema helpers shared by the BFF (server) and the UI (client).
// The schema itself is backend/deal_pipeline/oms_fields.json, mirrored here as omsFields.json;
// a test asserts the two copies are identical. Formats: docs/deal-pipeline-design.md §5.

import schemaJson from "./omsFields.json";
import type { FieldValues, OmsFieldDef, OmsSchema } from "./types";

export const OMS_SCHEMA: OmsSchema = schemaJson as OmsSchema;
export const OMS_FIELDS: OmsFieldDef[] = OMS_SCHEMA.fields;
export const OMS_SECTIONS: string[] = OMS_SCHEMA.sections;

const BY_KEY = new Map(OMS_FIELDS.map((f) => [f.key, f]));

export function fieldDef(key: string): OmsFieldDef | undefined {
  return BY_KEY.get(key);
}

/** Fields grouped in section order, each section in schema order. */
export function fieldsBySection(): { section: string; fields: OmsFieldDef[] }[] {
  return OMS_SECTIONS.map((section) => ({
    section,
    fields: OMS_FIELDS.filter((f) => f.section === section),
  }));
}

/** Every key present, blanks as "", schema defaults applied. */
export function emptyFields(): FieldValues {
  const out: FieldValues = {};
  for (const f of OMS_FIELDS) out[f.key] = f.default ?? "";
  return out;
}

/** Fill missing keys with defaults/blanks and drop unknown keys. */
export function normalizeFields(input: Partial<FieldValues> | undefined): FieldValues {
  const out = emptyFields();
  if (!input) return out;
  for (const [k, v] of Object.entries(input)) {
    if (BY_KEY.has(k)) out[k] = v == null ? "" : String(v);
  }
  return out;
}

// Format regexes — keep identical to backend/deal_pipeline/oms_schema.py.
export const FORMAT_PATTERNS: Record<string, RegExp> = {
  date: /^(1[0-2]|[1-9])\/(3[01]|[12][0-9]|[1-9])\/\d{4}$/,
  time: /^(1[0-2]|[1-9])(:[0-5]\d)?(AM|PM)$/,
  percent: /^-?\d+\.\d{3}%$/,
  mm: /^\d+\.\d{3}$/,
  price: /^\d+\.\d{3}$/,
  integer: /^\d+$/,
  boolean: /^(Yes|No)$/,
};

/**
 * Validate one value against its field definition.
 *
 * @returns null when valid, otherwise a short human-readable problem.
 */
export function validateFieldValue(def: OmsFieldDef, raw: string): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return def.required ? "required" : null;
  switch (def.type) {
    case "enum":
      return def.values?.includes(value)
        ? null
        : `must be one of ${def.values?.join(", ")}`;
    case "string": {
      if (def.max_length && value.length > def.max_length)
        return `longer than ${def.max_length} characters`;
      if (def.pattern && !new RegExp(def.pattern).test(value))
        return `must match ${def.pattern}`;
      return null;
    }
    case "integer": {
      if (!FORMAT_PATTERNS.integer.test(value)) return "must be a whole number";
      const n = Number(value);
      if (def.min != null && n < def.min) return `must be ≥ ${def.min}`;
      if (def.max != null && n > def.max) return `must be ≤ ${def.max}`;
      return null;
    }
    default: {
      const re = FORMAT_PATTERNS[def.type];
      if (re && !re.test(value)) return `expected ${formatHint(def.type)}`;
      return null;
    }
  }
}

export function formatHint(type: OmsFieldDef["type"]): string {
  switch (type) {
    case "date":
      return "M/D/YYYY";
    case "time":
      return "h[:mm]AM|PM, e.g. 12PM";
    case "percent":
      return "0.000%";
    case "mm":
      return "millions with 3 decimals, e.g. 500.000";
    case "price":
      return "3 decimals, e.g. 99.500";
    case "integer":
      return "a whole number";
    case "boolean":
      return "Yes or No";
    default:
      return "text";
  }
}

/** All problems across a record, keyed by field key. Empty object when clean. */
export function validateFields(fields: FieldValues): Record<string, string> {
  const problems: Record<string, string> = {};
  for (const f of OMS_FIELDS) {
    const p = validateFieldValue(f, fields[f.key] ?? "");
    if (p) problems[f.key] = p;
  }
  return problems;
}

function csvCell(v: string): string {
  const s = v ?? "";
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header row of labels + one data row, "\n" line endings, RFC 4180 quoting. */
export function toCsv(fields: FieldValues): string {
  const header = OMS_FIELDS.map((f) => csvCell(f.label)).join(",");
  const row = OMS_FIELDS.map((f) => csvCell(fields[f.key] ?? "")).join(",");
  return `${header}\n${row}\n`;
}

/** Keys whose current value differs from the original (for the review diff view). */
export function changedKeys(original: FieldValues, current: FieldValues): string[] {
  return OMS_FIELDS.map((f) => f.key).filter(
    (k) => (original[k] ?? "") !== (current[k] ?? ""),
  );
}

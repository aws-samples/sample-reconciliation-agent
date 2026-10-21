"use client";

import type { OmsFieldDef } from "@/lib/pipeline/types";
import { formatHint } from "@/lib/pipeline/omsSchema";
import { INPUT_CLASS } from "@/components/app-ui/ui";

/**
 * The editing control for one column, shaped by its type.
 *
 * Enums and booleans are selects, because a free-text "yes" is exactly the FORMAT_INVALID the OMS
 * rejects. Everything else is text with the expected format as its placeholder. Shared by the
 * deal grid and the Inbox's inline override editor, so both offer the same control for a column.
 */
export function FieldInput({
  def,
  value,
  invalid,
  onChange,
}: {
  def: OmsFieldDef;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const style = invalid ? { borderColor: "var(--rc-red)" } : undefined;
  const label = def.label;
  if (def.type === "enum" || def.type === "boolean") {
    const options = def.type === "boolean" ? ["Yes", "No"] : (def.values ?? []);
    return (
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLASS} w-full`}
        style={style}
      >
        <option value="">— blank —</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={def.type === "string" ? (def.pattern ? "e.g. 7 yr" : "text") : formatHint(def.type)}
      spellCheck={false}
      className={`${INPUT_CLASS} w-full`}
      style={style}
    />
  );
}

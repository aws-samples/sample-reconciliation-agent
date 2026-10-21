"use client";

import { useState } from "react";
import type { FieldEvidence, FieldOverride, FieldValues } from "@/lib/pipeline/types";
import { fieldsBySection } from "@/lib/pipeline/omsSchema";
import { Disclosure } from "@/components/app-ui/ui";
import { FieldInput } from "@/components/pipeline/FieldInput";
import { OverrideNote } from "@/components/pipeline/OverrideEditor";
import { ConfidenceChip } from "@/components/pipeline/ui";

// The review surface: every OMS column, grouped the way the OMS groups them, with the parser's value,
// the evidence behind it, and — in edit mode — a control shaped by the column's type. Validation is
// the same `validateFieldValue` the BFF runs, so a value the grid accepts is a value the PATCH accepts.

/** The evidence behind one value, shown on demand under the row. */
function EvidenceNote({ evidence }: { evidence: FieldEvidence }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="col-span-full">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="rc-mono text-[10.5px] uppercase tracking-[0.08em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
      >
        {open ? "▾ hide evidence" : "▸ evidence"}
      </button>
      {open && (
        <div className="mt-1 space-y-1.5 rounded bg-[var(--rc-panel-2)] p-3">
          {evidence.excerpt ? (
            <blockquote className="rc-mono whitespace-pre-wrap border-l-2 border-[var(--rc-cyan)] pl-3 text-[11.5px] leading-relaxed text-[var(--rc-ink-dim)]">
              {evidence.excerpt}
            </blockquote>
          ) : (
            <p className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              no excerpt — the value was inferred rather than read
            </p>
          )}
          {evidence.rule && (
            <p className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
              <span className="rc-eyebrow mr-2">rule</span>
              {evidence.rule}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function DealFieldGrid({
  fields,
  original,
  evidence,
  editing,
  problems,
  overrides = {},
  onRetract,
  onChange,
}: {
  /** Current values (the draft while editing). */
  fields: FieldValues;
  /** As parsed, for the changed-since-original marker. */
  original: FieldValues;
  evidence: Record<string, FieldEvidence>;
  editing: boolean;
  /** Validation problems keyed by field key, from `validateFields` on the draft. */
  problems: Record<string, string>;
  /** The override behind each field's current value, from `latestOverrides`. */
  overrides?: Record<string, FieldOverride>;
  /** Offered on an override's note when the viewer may retract its lesson (author or admin). */
  onRetract?: (override: FieldOverride) => ((o: FieldOverride) => Promise<void>) | undefined;
  onChange: (key: string, value: string) => void;
}) {
  return (
    <div className="space-y-3">
      {fieldsBySection().map(({ section, fields: defs }) => {
        const filled = defs.filter((f) => (fields[f.key] ?? "") !== "").length;
        const broken = defs.filter((f) => problems[f.key]).length;
        return (
          <Disclosure
            key={section}
            // Sections the parser filled open by default; the internal-decision sections (allocations,
            // desk fields) stay folded because they are blank by design at this stage.
            defaultOpen={filled > 0 || broken > 0}
            summary={
              <span className="rc-mono flex items-baseline gap-3 text-[12px]">
                <span className="text-[var(--rc-ink)]">{section}</span>
                <span className="text-[var(--rc-ink-faint)]">
                  {filled}/{defs.length} filled
                </span>
                {broken > 0 && (
                  <span style={{ color: "var(--rc-red)" }}>
                    {broken} problem{broken === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            }
          >
            <div className="divide-y divide-[var(--rc-line-soft)]">
              {defs.map((def) => {
                const value = fields[def.key] ?? "";
                const changed = value !== (original[def.key] ?? "");
                const problem = problems[def.key];
                const ev = evidence[def.key];
                const override = overrides[def.key];
                return (
                  <div
                    key={def.key}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] items-start gap-x-4 gap-y-1 px-3 py-2"
                    data-field={def.key}
                  >
                    <div className="pt-1.5">
                      <div className="rc-mono text-[11px] text-[var(--rc-ink-dim)]" title={def.key}>
                        {def.label}
                        {def.required && (
                          <span className="ml-1 text-[var(--rc-amber)]" title="required by the OMS">
                            *
                          </span>
                        )}
                      </div>
                      {def.notes && (
                        <div className="mt-0.5 text-[10.5px] leading-snug text-[var(--rc-ink-faint)]">
                          {def.notes}
                        </div>
                      )}
                    </div>
                    <div>
                      {editing ? (
                        <FieldInput
                          def={def}
                          value={value}
                          invalid={Boolean(problem)}
                          onChange={(v) => onChange(def.key, v)}
                        />
                      ) : (
                        <div
                          className="rc-mono break-words py-1.5 text-[12.5px]"
                          style={{ color: value ? "var(--rc-ink)" : "var(--rc-ink-faint)" }}
                        >
                          {value || "—"}
                        </div>
                      )}
                      {problem && (
                        <p role="alert" className="rc-mono mt-1 text-[11px]" style={{ color: "var(--rc-red)" }}>
                          {problem}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 pt-1.5">
                      {changed && (
                        <span
                          className="rc-chip"
                          style={{ color: "var(--rc-violet)" }}
                          title={`as parsed: ${original[def.key] || "(blank)"}`}
                          data-changed="true"
                        >
                          edited
                        </span>
                      )}
                      {ev && <ConfidenceChip level={ev.confidence} />}
                    </div>
                    {override && (
                      <div className="col-span-full">
                        <OverrideNote override={override} onRetract={onRetract?.(override)} />
                      </div>
                    )}
                    {ev && <EvidenceNote evidence={ev} />}
                  </div>
                );
              })}
            </div>
          </Disclosure>
        );
      })}
    </div>
  );
}

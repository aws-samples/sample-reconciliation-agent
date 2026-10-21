"use client";

import { useState } from "react";
import type { FieldOverride, OmsFieldDef, OverrideMemory } from "@/lib/pipeline/types";
import { validateFieldValue } from "@/lib/pipeline/omsSchema";
import { MAX_OVERRIDE_REASON_CHARS } from "@/lib/pipeline/overrides";
import { formatDateTime } from "@/components/pipeline/format";
import { FieldInput } from "@/components/pipeline/FieldInput";
import { BTN_CONFIRM, BTN_LINK, Eyebrow, INPUT_CLASS } from "@/components/app-ui/ui";

// Overriding one parsed value: the new value, the parser's value beside it, and the reason, which is
// required because it is the half of the correction the parser can learn from. The reason is stored
// on the deal and sent to the knowledge memory as a lesson, so the editor says so before Save.

/** What the reviewer is told about the lesson an override sent. */
const MEMORY_LABEL: Record<OverrideMemory["status"], string> = {
  sent: "lesson sent to memory",
  pending: "lesson pending",
  failed: "lesson not sent",
  off: "no memory deployed",
  retracted: "lesson retracted",
};

const MEMORY_COLOR: Record<OverrideMemory["status"], string> = {
  sent: "var(--rc-green)",
  pending: "var(--rc-amber)",
  failed: "var(--rc-red)",
  off: "var(--rc-ink-faint)",
  retracted: "var(--rc-ink-faint)",
};

/**
 * The override that explains a field's current value: who, when, why, and whether memory has it.
 *
 * With `onRetract` (the screen passes it to the override's author and to admins), a sent lesson can
 * be taken back from here. The override and its value stay; only what the parser learned goes.
 */
export function OverrideNote({
  override,
  onRetract,
}: {
  override: FieldOverride;
  onRetract?: (override: FieldOverride) => Promise<void>;
}) {
  const memory = override.memory;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retract = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRetract!(override);
      setConfirming(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const title =
    memory.status === "retracted"
      ? `retracted by ${memory.retracted_by ?? "unknown"}${memory.retracted_at ? ` · ${formatDateTime(memory.retracted_at)}` : ""}`
      : memory.error;
  return (
    <div className="mt-1 space-y-0.5 text-[11.5px] leading-relaxed" data-override={override.field}>
      <div className="rc-mono flex flex-wrap items-baseline gap-x-2 text-[10.5px] text-[var(--rc-ink-faint)]">
        <span className="rc-chip" style={{ color: "var(--rc-violet)" }}>
          overridden
        </span>
        <span>
          by {override.actor} · {formatDateTime(override.at)}
          {override.stage === "break" && " · fixing an OMS rejection"}
        </span>
        <span style={{ color: MEMORY_COLOR[memory.status] }} title={title}>
          {MEMORY_LABEL[memory.status]}
        </span>
        {onRetract && memory.status === "sent" && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="uppercase tracking-[0.08em] hover:text-[var(--rc-red)]"
          >
            retract lesson
          </button>
        )}
      </div>
      <p className="border-l-2 border-[var(--rc-violet)] pl-2 text-[var(--rc-ink-dim)]">
        {override.reason}
      </p>
      {confirming && (
        <div role="group" aria-label="Retract this lesson" className="rc-mono flex flex-wrap items-center gap-2 text-[10.5px]">
          <span className="text-[var(--rc-ink-dim)]">
            The parser stops recalling this lesson; the value stays on this deal.
          </span>
          <button type="button" onClick={retract} disabled={busy} className="uppercase tracking-[0.08em] text-[var(--rc-red)] disabled:opacity-40">
            {busy ? "retracting…" : "retract"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} disabled={busy} className="uppercase tracking-[0.08em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]">
            keep
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="rc-mono text-[10.5px]" style={{ color: "var(--rc-red)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The inline editor that replaces a parsed value with the reviewer's, and records why. */
export function OverrideEditor({
  def,
  current,
  parsed,
  onSave,
  onCancel,
}: {
  def: OmsFieldDef;
  /** The field's current value: the parser's, or an earlier override's. */
  current: string;
  /** The parser's value, shown beside the new one. */
  parsed: string;
  /** Persist the override; a rejection is shown in the editor and leaves it open. */
  onSave: (value: string, reason: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(current);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = validateFieldValue(def, value);
  const unchanged = value.trim() === current.trim();
  const ready = !busy && !unchanged && !problem && reason.trim() !== "";

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(value.trim(), reason.trim());
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div
      role="group"
      aria-label={`Override ${def.label}`}
      className="mt-1.5 space-y-2.5 rounded border border-[var(--rc-violet)] bg-[var(--rc-panel-2)] p-3"
    >
      <Eyebrow>Override · {def.label}</Eyebrow>
      <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2">
        <span className="rc-eyebrow">Value</span>
        <div>
          <FieldInput def={def} value={value} invalid={Boolean(problem)} onChange={setValue} />
          {problem && (
            <p role="alert" className="rc-mono mt-1 text-[11px]" style={{ color: "var(--rc-red)" }}>
              {problem}
            </p>
          )}
        </div>
        <span className="rc-eyebrow">Parsed</span>
        <span className="rc-mono text-[12px] text-[var(--rc-ink-dim)]">{parsed || "(blank)"}</span>
        <span className="rc-eyebrow pt-1.5">Why?</span>
        <textarea
          aria-label={`Reason for overriding ${def.label}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={MAX_OVERRIDE_REASON_CHARS}
          rows={2}
          placeholder="What the parser got wrong, and the rule that gives the right value…"
          className={`${INPUT_CLASS} w-full leading-relaxed`}
        />
      </div>
      <p className="rc-mono text-[10.5px] text-[var(--rc-ink-faint)]">
        Saved to the deal and to the parser&apos;s memory.
      </p>
      {error && (
        <p role="alert" className="rc-mono text-[11.5px]" style={{ color: "var(--rc-red)" }}>
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className={BTN_LINK}>
          Cancel
        </button>
        <button type="button" onClick={save} disabled={!ready} className={BTN_CONFIRM}>
          {busy ? "Saving…" : "Save override"}
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";

import { Panel } from "@/components/recon/ui";
import { createReconItems } from "@/lib/reconApi";
import { RECON_SAMPLES, withUniqueIds } from "@/lib/reconSamples";

// Manual reconciliation submission. Free-text JSON so an operator can paste an arbitrary payload
// shape while the upstream break-record contract is still being settled — validation is intake's job
// (pydantic), and its error text is surfaced verbatim rather than re-implemented here.
export function NewItemModal({
  onClose,
  onSubmitted,
}: {
  onClose: () => void;
  // Receives the item_ids that were actually written, so the caller can wait for THOSE cases to
  // appear rather than guessing when the pipeline has caught up.
  onSubmitted: (itemIds: string[]) => void;
}) {
  const [text, setText] = useState(
    JSON.stringify(RECON_SAMPLES[1].payload, null, 2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Escape closes. Without it the overlay is a trap for anyone not using the mouse — it covers the
  // whole viewport and the Close button is the only exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadSample = (index: number) => {
    // Suffix the ids: intake's conditional put SKIPS an existing item_id, so a second
    // submission of an unmodified sample would silently write nothing.
    const suffix = Math.random().toString(36).slice(2, 8);
    setText(
      JSON.stringify(
        withUniqueIds(RECON_SAMPLES[index].payload, suffix),
        null,
        2,
      ),
    );
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Parse locally first so a typo is an immediate, specific message instead of a 400.
      const parsed = JSON.parse(text) as {
        domain: string;
        items: Record<string, unknown>[];
      };
      const res = await createReconItems(parsed);
      if (res.written === 0) {
        // Not an error, and NOT a success either — this is the duplicate-item_id case. Reporting it
        // as success is what makes a resubmitted sample look like it vanished.
        setError(
          "0 items written — every item_id already exists. Load a sample again to get fresh ids.",
        );
        return;
      }
      onSubmitted(
        parsed.items
          .map((i) => String(i.item_id ?? ""))
          .filter((id) => id.length > 0),
      );
      onClose();
    } catch (e) {
      setError(
        e instanceof SyntaxError ? `Invalid JSON — ${e.message}` : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Create new reconciliation item"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
    >
      <Panel className="w-full max-w-3xl space-y-4 p-6">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="rc-display text-[22px] font-black text-[var(--rc-ink)]">
            Create New Item
          </h2>
          <button
            onClick={onClose}
            className="rc-mono text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
          >
            Close
          </button>
        </div>
        <p className="rc-mono text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
          Submits straight into the pipeline: Tier-1 runs first, and only
          escalates to the agent when it cannot resolve the item
          deterministically.
        </p>
        <div className="space-y-2">
          {RECON_SAMPLES.map((s, i) => (
            <button
              key={s.label}
              onClick={() => loadSample(i)}
              className="block w-full rounded border border-[var(--rc-line)] px-3 py-2 text-left hover:border-[var(--rc-cyan)]"
            >
              <span className="rc-mono text-[12px] text-[var(--rc-ink)]">
                {s.label}
              </span>
              <span className="rc-mono block text-[10px] text-[var(--rc-ink-faint)]">
                {s.expectation}
              </span>
            </button>
          ))}
        </div>
        <textarea
          aria-label="Payload JSON"
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={16}
          className="rc-mono w-full rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] p-3 text-[12px] text-[var(--rc-ink)]"
        />
        {error && (
          <p className="rc-mono text-[12px] text-[var(--rc-amber)]">{error}</p>
        )}
        <div className="flex justify-end gap-3">
          <button
            onClick={submit}
            disabled={busy}
            className="rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#040a10] disabled:opacity-40"
          >
            {busy ? "Submitting…" : "Submit"}
          </button>
        </div>
      </Panel>
    </div>
  );
}

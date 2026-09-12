"use client";

import Link from "next/link";
import type { UploadResult } from "@/lib/pipeline/types";
import { formatDateTime } from "@/components/pipeline/format";
import { BTN_PRIMARY, Eyebrow, Panel } from "@/components/app-ui/ui";

/**
 * What the mock OMS said about the last upload attempt.
 *
 * A rejection is rendered as a table of stable error codes with the validator's own hint text, and
 * one button that hands exactly this deal to the assistant. That hand-off is the demo's hinge: the
 * assistant reads the same codes and proposes either a skill change or a memory.
 */
export function UploadResultPanel({
  upload,
  dealId,
}: {
  upload: UploadResult | null;
  dealId: string;
}) {
  return (
    <Panel className="rc-rise p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>OMS upload · last attempt</Eyebrow>
        {upload && (
          <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
            {formatDateTime(upload.attempted_at)} · validator {upload.validator_version}
          </span>
        )}
      </div>

      {!upload ? (
        <p className="rc-mono mt-3 text-[12px] text-[var(--rc-ink-faint)]">
          ◇ not uploaded yet — approve the deal to send the staging file to the OMS
        </p>
      ) : upload.accepted ? (
        <div className="mt-3">
          <p className="rc-mono text-[13px]" style={{ color: "var(--rc-green)" }}>
            ✓ accepted
          </p>
          <p className="rc-mono mt-1 text-[12px] text-[var(--rc-ink-dim)]">
            staged at <span className="text-[var(--rc-ink)]">{upload.staging_key ?? "—"}</span>
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="rc-mono text-[13px]" style={{ color: "var(--rc-red)" }}>
            ✕ rejected — {upload.errors.length} error{upload.errors.length === 1 ? "" : "s"}
          </p>
          <div className="overflow-hidden rounded border border-[var(--rc-line)]">
            <div className="rc-eyebrow grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.4fr)] gap-3 border-b border-[var(--rc-line)] bg-[var(--rc-line-soft)]/40 px-3 py-2">
              <span>Code</span>
              <span>Field</span>
              <span>Message</span>
            </div>
            {upload.errors.map((e, i) => (
              <div
                key={`${e.code}-${i}`}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2.4fr)] gap-3 border-b border-[var(--rc-line-soft)] px-3 py-2 last:border-0"
              >
                <span className="rc-mono break-all text-[11.5px]" style={{ color: "var(--rc-red)" }}>
                  {e.code}
                </span>
                <span className="rc-mono break-all text-[11.5px] text-[var(--rc-ink-dim)]">
                  {e.field ?? "—"}
                </span>
                <span className="text-[12px] leading-relaxed text-[var(--rc-ink)]">
                  {e.message}
                  {e.hint && (
                    <span className="mt-1 block text-[11.5px] text-[var(--rc-ink-dim)]">
                      <span className="rc-eyebrow mr-2">hint</span>
                      {e.hint}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
          <Link
            href={`/pipeline/assistant?deal=${encodeURIComponent(dealId)}`}
            className={`${BTN_PRIMARY} inline-block`}
          >
            Ask the assistant about this →
          </Link>
        </div>
      )}
    </Panel>
  );
}

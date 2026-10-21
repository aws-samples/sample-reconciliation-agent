"use client";

import type { ReactNode } from "react";
import { Eyebrow, Panel, Pill } from "@/components/app-ui/ui";

// The reconciliation console's own instrument primitives. The generic ones — Panel, Eyebrow,
// Disclosure, Modal, Placeholder — live in `@/components/app-ui/ui` (shared with every app) and are
// re-exported here so the recon pages' imports do not move. What stays in this file is the recon
// vocabulary: which case statuses exist and what colour each is, the segmented confidence meter, and
// the stat tile on the dashboard.
export {
  Disclosure,
  Eyebrow,
  Modal,
  Panel,
  Placeholder,
} from "@/components/app-ui/ui";

// Map a case status to a signal color + label.
const STATUS_COLOR: Record<string, string> = {
  PENDING: "var(--rc-amber)",
  IN_PROGRESS: "var(--rc-violet)",
  PROPOSED: "var(--rc-cyan)",
  APPROVED: "var(--rc-green)",
  REJECTED: "var(--rc-red)",
  RESOLVED: "var(--rc-green)",
  AUTO_CLEARED: "var(--rc-green)",
  AGED: "var(--rc-red)",
  FAILED: "var(--rc-red)",
};

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "var(--rc-ink-dim)";
  return <Pill color={color}>{status.replace(/_/g, " ")}</Pill>;
}

// Confidence as a 10-segment meter, colored by band (low=red, mid=amber, high=cyan/green).
export function ConfidenceMeter({
  value,
  showValue = true,
}: {
  value?: number | string;
  showValue?: boolean;
}) {
  const v = typeof value === "string" ? parseFloat(value) : (value ?? 0);
  const pct = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  const filled = Math.round(pct * 10);
  const seg =
    pct >= 0.8
      ? "var(--rc-cyan)"
      : pct >= 0.5
        ? "var(--rc-amber)"
        : "var(--rc-red)";
  return (
    <div className="flex items-center gap-3">
      <div className="rc-meter" style={{ ["--rc-seg" as string]: seg }}>
        {Array.from({ length: 10 }).map((_, i) => (
          <span
            key={i}
            className={`rc-meter-seg ${i < filled ? "on" : ""} ${
              i < filled && i >= filled - 1 ? "glow" : ""
            }`}
          />
        ))}
      </div>
      {showValue && (
        <span className="rc-mono rc-tnum text-[13px]" style={{ color: seg }}>
          {(pct * 100).toFixed(0)}%
        </span>
      )}
    </div>
  );
}

// A labeled stat tile with a big monospaced figure.
export function Stat({
  label,
  value,
  accent = "var(--rc-ink)",
  sub,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  accent?: string;
  sub?: string;
  delay?: number;
}) {
  return (
    <Panel className="rc-rise p-5">
      <div style={{ animationDelay: `${delay}ms` }}>
        <Eyebrow>{label}</Eyebrow>
        <div
          className="rc-mono rc-tnum mt-3 text-[38px] leading-none"
          style={{ color: accent }}
        >
          {value}
        </div>
        {sub && (
          <div className="rc-mono mt-2 text-[11px] text-[var(--rc-ink-faint)]">
            {sub}
          </div>
        )}
      </div>
    </Panel>
  );
}

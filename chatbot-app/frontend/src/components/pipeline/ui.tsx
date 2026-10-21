"use client";

import { Pill } from "@/components/app-ui/ui";
import type { Confidence } from "@/lib/pipeline/types";

// The Deal Pipeline console's own instrument primitives. The generic ones — Panel, Eyebrow,
// Disclosure, Modal, Placeholder, Notice, the button and input classes — live in
// `@/components/app-ui/ui` (shared with every app) and are imported from there directly. What stays
// in this file is the pipeline vocabulary: which record statuses exist, what colour each is and which
// are still moving, and the parser's confidence chip.

// Every status the console shows, mapped to a signal colour. Three record types share one pill so
// the same colour means the same thing everywhere: amber is waiting, violet is in motion, green is
// done, red needs a person, cyan is ready for a decision.
const STATUS_COLOR: Record<string, string> = {
  // emails
  RECEIVED: "var(--rc-amber)",
  PARSING: "var(--rc-violet)",
  PARSED: "var(--rc-green)",
  PARSE_FAILED: "var(--rc-red)",
  // deals
  STAGED: "var(--rc-cyan)",
  APPROVED: "var(--rc-violet)",
  UPLOADED: "var(--rc-green)",
  UPLOAD_FAILED: "var(--rc-red)",
  REJECTED: "var(--rc-red)",
  // proposals
  PENDING: "var(--rc-amber)",
};

/** Statuses that are still moving: the pill's dot breathes so a row that is about to change says so. */
const LIVE_STATUSES = new Set(["RECEIVED", "PARSING", "APPROVED"]);

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "var(--rc-ink-dim)";
  return (
    <Pill color={color} live={LIVE_STATUSES.has(status)} data-status={status}>
      {status.replace(/_/g, " ")}
    </Pill>
  );
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: "var(--rc-green)",
  medium: "var(--rc-amber)",
  low: "var(--rc-red)",
};

/**
 * The parser's confidence in one field, as a small coloured chip.
 *
 * Three bands rather than a number: the parser reports a band, and a chip that says "medium" in
 * amber is what a reviewer scans a column of seventy fields for. `data-confidence` is on the element
 * so a test — or a stylesheet — can read the band without parsing a colour.
 */
export function ConfidenceChip({ level }: { level: Confidence }) {
  return (
    <span
      className="rc-chip"
      style={{ color: CONFIDENCE_COLOR[level] ?? "var(--rc-ink-dim)" }}
      data-confidence={level}
      title={`parser confidence: ${level}`}
    >
      {level}
    </span>
  );
}

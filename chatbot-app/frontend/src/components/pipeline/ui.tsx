"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Confidence } from "@/lib/pipeline/types";

// Shared "instrument" primitives for the Deal Pipeline console. Deliberately small and
// dependency-free — the aesthetic lives in pipeline-theme.css; these compose it.

// Every status the console shows, mapped to a signal colour. Three record types share one pill so
// the same colour means the same thing everywhere: amber is waiting, violet is in motion, green is
// done, red needs a person, cyan is ready for a decision.
const STATUS_COLOR: Record<string, string> = {
  // emails
  RECEIVED: "var(--dp-amber)",
  PARSING: "var(--dp-violet)",
  PARSED: "var(--dp-green)",
  PARSE_FAILED: "var(--dp-red)",
  // deals
  STAGED: "var(--dp-cyan)",
  APPROVED: "var(--dp-violet)",
  UPLOADED: "var(--dp-green)",
  UPLOAD_FAILED: "var(--dp-red)",
  REJECTED: "var(--dp-red)",
  // proposals
  PENDING: "var(--dp-amber)",
};

/** Statuses that are still moving: the pill's dot breathes so a row that is about to change says so. */
const LIVE_STATUSES = new Set(["RECEIVED", "PARSING", "APPROVED"]);

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? "var(--dp-ink-dim)";
  return (
    <span
      className={`dp-pill ${LIVE_STATUSES.has(status) ? "live" : ""}`}
      style={{ color }}
      data-status={status}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: "var(--dp-green)",
  medium: "var(--dp-amber)",
  low: "var(--dp-red)",
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
      className="dp-chip"
      style={{ color: CONFIDENCE_COLOR[level] ?? "var(--dp-ink-dim)" }}
      data-confidence={level}
      title={`parser confidence: ${level}`}
    >
      {level}
    </span>
  );
}

export function Panel({
  children,
  className = "",
  scan = false,
  onClick,
  title,
}: {
  children: ReactNode;
  className?: string;
  scan?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <div
      className={`dp-panel ${scan ? "dp-scan" : ""} ${className}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </div>
  );
}

export function Eyebrow({
  children,
  title,
}: {
  children: ReactNode;
  title?: string;
}) {
  // A styled hover tooltip on the ⓘ affordance, rather than the native `title` attribute, which
  // renders only the help cursor with no readable text. CSS-only via Tailwind group-hover, so no
  // provider is needed and it works everywhere Eyebrow is used.
  if (!title) return <div className="dp-eyebrow">{children}</div>;
  return (
    <div className="dp-eyebrow inline-flex items-center gap-1">
      {children}
      <span className="group relative inline-flex cursor-help items-center">
        <span
          aria-hidden
          className="text-[var(--dp-ink-faint)] transition-colors group-hover:text-[var(--dp-ink)]"
        >
          ⓘ
        </span>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-[150%] z-50 max-w-[260px] -translate-x-1/2 rounded-md border border-[var(--dp-line)] bg-[var(--dp-panel-2)] px-3 py-2 text-[11px] font-normal normal-case leading-snug tracking-normal text-[var(--dp-ink)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
        >
          {title}
        </span>
      </span>
    </div>
  );
}

/**
 * One collapsible row: a clickable summary line that reveals `children` when opened.
 *
 * For surfaces that would otherwise stack several tall bodies on top of each other — the evidence
 * behind seventy parsed fields, the prompt behind a memory strategy. Collapsed is the default: the
 * row label is what a reviewer scans, and the body is what they open once they have found the row
 * they want.
 *
 * Open state lives here, so rows are independent — one can be left open while a sibling is read.
 */
export function Disclosure({
  summary,
  meta,
  defaultOpen = false,
  keepMounted = false,
  className = "",
  style,
  children,
}: {
  /** The always-visible row content. */
  summary: ReactNode;
  /** Right-aligned secondary text on the row, e.g. a line count or a confidence chip. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  /**
   * Keep `children` mounted while collapsed, hidden with CSS instead of unmounted.
   *
   * Needed wherever the body holds state a person would be upset to lose — a half-written rule.
   * Left off for bodies that only render their props, so a long body costs nothing while closed.
   */
  keepMounted?: boolean;
  className?: string;
  /** For the one thing callers dim rather than hide, e.g. a retired row. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className={`overflow-hidden rounded border border-[var(--dp-line)] ${className}`}
      style={style}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--dp-panel-2)]"
      >
        <span
          aria-hidden
          className="dp-mono inline-block text-[11px] text-[var(--dp-ink-faint)] transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
        {meta && (
          <span className="dp-mono shrink-0 text-[11px] text-[var(--dp-ink-faint)]">
            {meta}
          </span>
        )}
      </button>
      {(open || keepMounted) && (
        <div className={open ? "border-t border-[var(--dp-line)]" : "hidden"}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Overlay dialog shell: the backdrop, the panel, the heading, the close affordance, Escape to close.
 *
 * Clicking the backdrop deliberately does NOT close it. These dialogs hold typed-in forms — a pasted
 * email, a rejection reason — and a stray click outside a half-written one should not discard it.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  className = "max-w-2xl",
}: {
  title: string;
  /** Optional line under the heading, for what this dialog writes and where it lands. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Width class; the default suits a short form. */
  className?: string;
}) {
  // Escape closes. Without it the overlay is a trap for anyone not using the mouse — it covers the
  // whole viewport and the Close button is the only exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
    >
      <Panel className={`w-full space-y-4 p-6 ${className}`}>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="dp-display text-[22px] font-black text-[var(--dp-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="dp-mono text-[12px] uppercase tracking-[0.1em] text-[var(--dp-ink-faint)] hover:text-[var(--dp-ink)]"
          >
            Close
          </button>
        </div>
        {subtitle && (
          <p className="dp-mono text-[11px] leading-relaxed text-[var(--dp-ink-dim)]">
            {subtitle}
          </p>
        )}
        {children}
      </Panel>
    </div>
  );
}

// Full-bleed centered state (loading / empty / error) inside a dashed panel.
export function Placeholder({
  kind = "empty",
  children,
}: {
  kind?: "empty" | "error" | "loading";
  children: ReactNode;
}) {
  const color =
    kind === "error"
      ? "var(--dp-red)"
      : kind === "loading"
        ? "var(--dp-cyan)"
        : "var(--dp-ink-dim)";
  return (
    <div
      className="dp-mono flex min-h-[220px] items-center justify-center rounded border border-dashed p-8 text-center text-[13px]"
      style={{ borderColor: "var(--dp-line)", color }}
      data-kind={kind}
    >
      {children}
    </div>
  );
}

/** What an action reported, for a `Notice`: which way it went, and the line to show for it. */
export interface ActionOutcome {
  tone: "success" | "error";
  text: string;
}

/**
 * The one-line outcome of an action — a save, an apply, a delete — beside the control that ran it.
 *
 * The tone is explicit rather than inferred from the text, because the same slot carries "Saved." and
 * "Error: this endpoint requires membership of the admin group", and the two must never look alike: a
 * refused write drawn in the accent colour reads as a confirmation. Errors are announced (`role="alert"`)
 * so assistive tech hears why nothing changed; successes are polite status updates. `data-tone` is on
 * the element so a test — or a stylesheet — can read the verdict without parsing a colour.
 */
export function Notice({
  tone,
  children,
  className = "text-[12px]",
}: {
  tone: ActionOutcome["tone"];
  children: ReactNode;
  /** Size and spacing. Replaces the default rather than adding to it, so two text sizes never compete. */
  className?: string;
}) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      data-tone={tone}
      className={`dp-mono ${className}`}
      style={{ color: tone === "error" ? "var(--dp-red)" : "var(--dp-cyan)" }}
    >
      {children}
    </p>
  );
}

// The button styles every page uses, named by intent so a page never has to pick a colour. Kept as
// strings rather than components because half the call sites are `<Link>`s and half are `<button>`s.
export const BTN_PRIMARY =
  "dp-mono rounded border border-[var(--dp-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--dp-cyan)] hover:bg-[var(--dp-cyan)] hover:text-[#040a10] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--dp-cyan)]";
export const BTN_CONFIRM =
  "dp-mono rounded border border-[var(--dp-green)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--dp-green)] hover:bg-[var(--dp-green)] hover:text-[#04120f] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--dp-green)]";
export const BTN_DANGER =
  "dp-mono rounded border border-[var(--dp-amber)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--dp-amber)] hover:bg-[var(--dp-amber)] hover:text-[#140a00] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--dp-amber)]";
export const BTN_QUIET =
  "dp-mono rounded border border-[var(--dp-line)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--dp-ink-dim)] hover:text-[var(--dp-ink)] disabled:opacity-40";
export const BTN_LINK =
  "dp-mono px-2 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--dp-ink-faint)] hover:text-[var(--dp-ink)] disabled:opacity-40";
export const INPUT_CLASS =
  "dp-mono rounded border border-[var(--dp-line)] bg-[var(--dp-panel-2)] px-3 py-1.5 text-[12px] text-[var(--dp-ink)] outline-none focus:border-[var(--dp-cyan)]";

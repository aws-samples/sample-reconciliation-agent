"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

// Shared "instrument" primitives for the reconciliation console. Deliberately small and
// dependency-free — the aesthetic lives in recon-theme.css; these compose it.

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
  return (
    <span className="rc-pill" style={{ color }}>
      {status.replace(/_/g, " ")}
    </span>
  );
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
      className={`rc-panel ${scan ? "rc-scan" : ""} ${className}`}
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
  if (!title) return <div className="rc-eyebrow">{children}</div>;
  return (
    <div className="rc-eyebrow inline-flex items-center gap-1">
      {children}
      <span className="group relative inline-flex cursor-help items-center">
        <span
          aria-hidden
          className="text-[var(--rc-ink-faint)] transition-colors group-hover:text-[var(--rc-ink)]"
        >
          ⓘ
        </span>
        <span
          role="tooltip"
          className="pointer-events-none absolute left-1/2 top-[150%] z-50 max-w-[260px] -translate-x-1/2 rounded-md border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[11px] font-normal normal-case leading-snug tracking-normal text-[var(--rc-ink)] opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
        >
          {title}
        </span>
      </span>
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

/**
 * One collapsible row: a clickable summary line that reveals `children` when opened.
 *
 * For surfaces that would otherwise stack several tall bodies on top of each other — the read-only
 * source files, the email templates. Collapsed is the default: the row label is what an operator scans,
 * and the body is what they open once they have found the row they want.
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
  /** Right-aligned secondary text on the row, e.g. a line count or a revision. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  /**
   * Keep `children` mounted while collapsed, hidden with CSS instead of unmounted.
   *
   * Needed wherever the body holds state an operator would be upset to lose — a half-written template.
   * Left off for bodies that only render their props, so a long file costs nothing while closed.
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
      className={`overflow-hidden rounded border border-[var(--rc-line)] ${className}`}
      style={style}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--rc-panel-2)]"
      >
        <span
          aria-hidden
          className="rc-mono inline-block text-[11px] text-[var(--rc-ink-faint)] transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          ▸
        </span>
        <span className="min-w-0 flex-1">{summary}</span>
        {meta && (
          <span className="rc-mono shrink-0 text-[11px] text-[var(--rc-ink-faint)]">
            {meta}
          </span>
        )}
      </button>
      {(open || keepMounted) && (
        <div className={open ? "border-t border-[var(--rc-line)]" : "hidden"}>
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Overlay dialog shell: the backdrop, the panel, the heading, the close affordance, Escape to close.
 *
 * Every "add a new X" flow on the Config tab opens one of these rather than parking a permanently empty
 * row at the bottom of a list of real ones. An empty row reads as a record that exists, and its
 * placeholder text reads as a value someone saved.
 *
 * Clicking the backdrop deliberately does NOT close it. These dialogs hold typed-in forms, and a stray
 * click outside a half-written template should not discard it.
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
          <h2 className="rc-display text-[22px] font-black text-[var(--rc-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rc-mono text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)]"
          >
            Close
          </button>
        </div>
        {subtitle && (
          <p className="rc-mono text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
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
      ? "var(--rc-red)"
      : kind === "loading"
        ? "var(--rc-cyan)"
        : "var(--rc-ink-dim)";
  return (
    <div
      className="rc-mono flex min-h-[220px] items-center justify-center rounded border border-dashed p-8 text-center text-[13px]"
      style={{ borderColor: "var(--rc-line)", color }}
    >
      {children}
    </div>
  );
}

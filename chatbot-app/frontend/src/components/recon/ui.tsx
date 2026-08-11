"use client";

import type { ReactNode } from "react";

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

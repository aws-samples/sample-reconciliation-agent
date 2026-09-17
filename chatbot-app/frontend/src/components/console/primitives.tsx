import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import type { ResolvedSetting, SettingSource } from "@/lib/console/types";
import { cn } from "@/lib/utils";

// The Settings screen's building blocks. Styled with the `--shell-*` palette only: the console's own
// screens sit in the shell's content column, beside neither app's theme, so they must read the same
// whichever app the viewer came from.

export const INPUT_CLASS =
  "w-full rounded-md border border-[var(--shell-line)] bg-[var(--shell-bg)] px-3 py-1.5 font-mono text-label text-[var(--shell-ink)] outline-none " +
  "focus:border-[var(--shell-accent)] disabled:cursor-not-allowed disabled:opacity-60";

export const BUTTON_PRIMARY =
  "inline-flex items-center gap-2 rounded-md border border-[var(--shell-accent)] bg-[var(--shell-accent-soft)] px-3 py-1.5 text-label text-[var(--shell-ink)] " +
  "hover:bg-[var(--shell-accent)] hover:text-[var(--shell-bg)] disabled:opacity-40 disabled:hover:bg-[var(--shell-accent-soft)] disabled:hover:text-[var(--shell-ink)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]";

export const BUTTON_QUIET =
  "inline-flex items-center gap-2 rounded-md border border-[var(--shell-line)] px-3 py-1.5 text-label text-[var(--shell-ink-dim)] " +
  "hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)] disabled:opacity-40 disabled:hover:border-[var(--shell-line)] disabled:hover:text-[var(--shell-ink-dim)] " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]";

/** What each source is called on the chip. Short, because the chip sits beside an input. */
const SOURCE_LABEL: Record<SettingSource, string> = {
  stored: "stored",
  env: "env",
  default: "default",
};

/**
 * The sentence behind a source chip. This is the chip's accessible name: the abbreviation alone
 * tells an operator nothing about WHICH variable would take over if the stored value were cleared.
 */
export function describeSource(setting: ResolvedSetting): string {
  switch (setting.source) {
    case "stored":
      return setting.envName
        ? `Stored in the console; overrides ${setting.envName}`
        : "Stored in the console";
    case "env":
      return setting.envName ? `From the environment variable ${setting.envName}` : "From the environment";
    default:
      return setting.envName
        ? `Built-in default; ${setting.envName} is unset and nothing is stored`
        : "Built-in default";
  }
}

/** Where a resolved value came from, beside its field. `role="img"` so the full sentence is its name. */
export function SourceChip({ setting, testId }: { setting: ResolvedSetting; testId?: string }) {
  const description = describeSource(setting);
  return (
    <span
      role="img"
      aria-label={description}
      title={description}
      data-source={setting.source}
      data-testid={testId}
      className={cn(
        "inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] uppercase tracking-[0.08em]",
        setting.source === "stored"
          ? "border-[var(--shell-accent)] text-[var(--shell-accent)]"
          : "border-[var(--shell-line)] text-[var(--shell-ink-dim)]",
      )}
    >
      {SOURCE_LABEL[setting.source]}
    </span>
  );
}

/** A titled block of one section. */
export function Section({
  title,
  description,
  children,
  testId,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className="flex flex-col gap-4 rounded-lg border border-[var(--shell-line)] bg-[var(--shell-panel)] p-6"
    >
      <div>
        <h2 className="text-title font-semibold">{title}</h2>
        {description && <p className="mt-1 text-label text-[var(--shell-ink-dim)]">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** A labelled control with an optional hint and validation message. */
export function Field({
  id,
  label,
  hint,
  error,
  trailing,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  /** Shown in place of the hint and announced; the input is marked invalid by the caller. */
  error?: string | null;
  /** Rendered on the label row, right-aligned: the source chip. */
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-label text-[var(--shell-ink)]">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-caption text-[var(--shell-danger)]">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-caption text-[var(--shell-ink-dim)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type NoteTone = "info" | "warn" | "error" | "success";

const NOTE_ICON = {
  info: Info,
  warn: AlertTriangle,
  error: AlertTriangle,
  success: CheckCircle2,
} as const;

const NOTE_CLASS: Record<NoteTone, string> = {
  info: "border-[var(--shell-line)] text-[var(--shell-ink-dim)]",
  warn: "border-[var(--shell-warn)] text-[var(--shell-ink)]",
  error: "border-[var(--shell-danger)] text-[var(--shell-ink)]",
  success: "border-[var(--shell-ok)] text-[var(--shell-ink)]",
};

const NOTE_ICON_CLASS: Record<NoteTone, string> = {
  info: "text-[var(--shell-ink-dim)]",
  warn: "text-[var(--shell-warn)]",
  error: "text-[var(--shell-danger)]",
  success: "text-[var(--shell-ok)]",
};

/**
 * One short explanation with a tone.
 *
 * Errors are announced (`role="alert"`); successes are polite status updates; warnings and
 * information are plain notes, since they describe a standing state rather than something that just
 * happened. `data-tone` is on the element so a test can read the verdict without parsing a colour.
 */
export function Note({
  tone,
  children,
  testId,
  className,
}: {
  tone: NoteTone;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const Icon = NOTE_ICON[tone];
  const role = tone === "error" ? "alert" : tone === "success" ? "status" : "note";
  return (
    <div
      role={role}
      data-tone={tone}
      data-testid={testId}
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-label", NOTE_CLASS[tone], className)}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", NOTE_ICON_CLASS[tone])} aria-hidden="true" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A yes/no cell in the access tables, readable as text as well as by colour. */
export function YesNo({ value }: { value: boolean }) {
  return (
    <span
      className={cn("font-mono text-label", value ? "text-[var(--shell-ok)]" : "text-[var(--shell-ink-dim)]")}
      data-value={value ? "yes" : "no"}
    >
      {value ? "yes" : "no"}
    </span>
  );
}

/** Table styling shared by the Users section's two tables. */
export const TABLE_CLASS = "w-full border-collapse text-left text-label";
export const TH_CLASS = "border-b border-[var(--shell-line)] py-1.5 pr-4 font-medium text-[var(--shell-ink-dim)]";
export const TD_CLASS = "border-b border-[var(--shell-line)] py-1.5 pr-4";

/** A monospace inline value: a subject, a group, a variable name. */
export function Mono({ children }: { children: ReactNode }) {
  return <code className="rounded bg-[var(--shell-bg)] px-1 py-px font-mono text-[0.92em]">{children}</code>;
}

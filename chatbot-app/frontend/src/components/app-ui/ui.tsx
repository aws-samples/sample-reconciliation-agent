"use client";

import {
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
} from "react";

// Shared "instrument" primitives for every app in the console. Deliberately small and
// dependency-free — the aesthetic lives in `src/app/app-theme.css` (the `rc-` classes and `--rc-*`
// tokens, scoped under `.app-root`); these compose it.
//
// What is here is what every app renders identically. Anything that carries one app's own vocabulary
// — which statuses exist and what colour each is, how confidence is drawn — stays in that app's own
// `components/<app>/ui.tsx`, built on the generic pieces below (`Pill` under each app's `StatusPill`).

/**
 * The status pill, generic: a monospaced label with a glowing dot, drawn in `color`.
 *
 * `live` makes the dot breathe (`.rc-pill.live` in the theme) for a record that is still moving. Any
 * other span attribute passes through, which is how an app's `StatusPill` adds `data-status` so a
 * test — or a stylesheet — can read the status without parsing a colour.
 */
export function Pill({
  color,
  live = false,
  className,
  style,
  children,
  ...rest
}: {
  color: string;
  live?: boolean;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<"span">, "color" | "children">) {
  const classes = ["rc-pill", live ? "live" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes} style={{ ...style, color }} {...rest}>
      {children}
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

/**
 * One collapsible row: a clickable summary line that reveals `children` when opened.
 *
 * For surfaces that would otherwise stack several tall bodies on top of each other — read-only source
 * files, email templates, the evidence behind seventy parsed fields. Collapsed is the default: the row
 * label is what a viewer scans, and the body is what they open once they have found the row they want.
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
  /** Right-aligned secondary text on the row, e.g. a line count, a revision or a confidence chip. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  /**
   * Keep `children` mounted while collapsed, hidden with CSS instead of unmounted.
   *
   * Needed wherever the body holds state a person would be upset to lose — a half-written template.
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
 * Every "add a new X" flow opens one of these rather than parking a permanently empty row at the
 * bottom of a list of real ones. An empty row reads as a record that exists, and its placeholder text
 * reads as a value someone saved.
 *
 * Clicking the backdrop deliberately does NOT close it. These dialogs hold typed-in forms — a template,
 * a pasted email, a rejection reason — and a stray click outside a half-written one should not discard
 * it.
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

// Full-bleed centered state (loading / empty / error) inside a dashed panel. `data-kind` is on the
// element so a test can tell an empty state from an error without parsing a colour.
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
      className={`rc-mono ${className}`}
      style={{ color: tone === "error" ? "var(--rc-red)" : "var(--rc-cyan)" }}
    >
      {children}
    </p>
  );
}

// The button styles every page uses, named by intent so a page never has to pick a colour. Kept as
// strings rather than components because half the call sites are `<Link>`s and half are `<button>`s.
export const BTN_PRIMARY =
  "rc-mono rounded border border-[var(--rc-cyan)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-cyan)] hover:bg-[var(--rc-cyan)] hover:text-[#040a10] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--rc-cyan)]";
export const BTN_CONFIRM =
  "rc-mono rounded border border-[var(--rc-green)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--rc-green)]";
export const BTN_DANGER =
  "rc-mono rounded border border-[var(--rc-amber)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-amber)] hover:bg-[var(--rc-amber)] hover:text-[#140a00] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--rc-amber)]";
export const BTN_QUIET =
  "rc-mono rounded border border-[var(--rc-line)] px-4 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)] disabled:opacity-40";
export const BTN_LINK =
  "rc-mono px-2 py-2 text-[12px] uppercase tracking-[0.1em] text-[var(--rc-ink-faint)] hover:text-[var(--rc-ink)] disabled:opacity-40";
export const INPUT_CLASS =
  "rc-mono rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-1.5 text-[12px] text-[var(--rc-ink)] outline-none focus:border-[var(--rc-cyan)]";

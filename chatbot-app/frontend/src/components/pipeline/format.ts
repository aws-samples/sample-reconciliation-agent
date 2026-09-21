// Display formatting shared by the pipeline pages. Every timestamp on the wire is ISO-8601 and every
// one is shown to a person, so the conversion lives in one place.

/**
 * An ISO-8601 timestamp as a compact local date-time, e.g. `10 Aug 2026, 09:42`.
 *
 * Falls back to the raw string rather than "Invalid Date": a value the parser could not read is still
 * more useful on screen than a label saying it is broken.
 *
 * @param iso the timestamp, or null/undefined for an absence.
 * @returns the formatted text, or an em dash for an absence.
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Milliseconds as a human duration: `840 ms`, `12.4 s`, `1m 05s`.
 *
 * @param ms the elapsed time.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * A short label for a `source_kind`, for table cells and pills.
 *
 * @param kind the wire value.
 */
export function sourceLabel(kind: string): string {
  switch (kind) {
    case "news-alert":
      return "market news alert";
    case "bank-notice":
      return "bank notice";
    case "manual":
      return "pasted";
    default:
      return kind;
  }
}

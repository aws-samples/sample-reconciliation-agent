/**
 * Persistence for the one piece of shell state the viewer controls: whether the rail is collapsed.
 *
 * Kept out of the component so the storage contract (key, encoding, failure behaviour) is testable
 * without rendering, and so a second consumer (a keyboard shortcut, a settings page) writes the same
 * thing the rail reads.
 */

/** localStorage key. Namespaced with `shell:` so it cannot collide with either app's own preferences. */
export const RAIL_COLLAPSED_KEY = "shell:rail:collapsed";

/**
 * Viewports at or above this width show the rail expanded when the viewer has not said otherwise.
 *
 * Mirrors Tailwind's `lg` breakpoint. Below it, a 220px rail next to either app's single-row header
 * (brand, tabs, identity chip) pushes the header into horizontal overflow on common laptop widths, so
 * the rail starts collapsed there and the viewer can expand it by hand.
 */
export const WIDE_VIEWPORT_QUERY = "(min-width: 1024px)";

/**
 * The persisted collapsed preference.
 *
 * @returns `true` or `false` when the viewer has toggled the rail at least once, `null` when they
 *   never have. The distinction matters: with no explicit choice the rail follows the viewport
 *   width, whereas an explicit choice is honoured at every width. Anything unreadable — a stale
 *   value from an older encoding, storage disabled by policy — counts as "no preference".
 */
export function readRailPreference(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RAIL_COLLAPSED_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    // Storage can throw (private mode with quota 0, a sandboxed iframe). Losing the preference is fine;
    // losing the rail is not.
    return null;
  }
}

/**
 * Persist the collapsed flag.
 *
 * @param collapsed the new state. Swallows storage errors for the same reason `readRailPreference` does.
 */
export function writeRailCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // See readRailPreference.
  }
}

/**
 * Whether the viewport is wide enough for the expanded rail to be the default.
 *
 * @returns `true` at or above `WIDE_VIEWPORT_QUERY`; also `true` when there is no `matchMedia` to
 *   ask (server, an old test environment), because expanded is the state that shows the most and
 *   therefore the right one to land in by accident.
 */
export function isViewportWide(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia(WIDE_VIEWPORT_QUERY).matches;
}

/**
 * Follow viewport-width changes across `WIDE_VIEWPORT_QUERY`.
 *
 * @param onChange called with the new "wide" flag each time the viewport crosses the breakpoint.
 * @returns an unsubscribe function; a no-op when there is no `matchMedia`.
 */
export function subscribeViewportWide(onChange: (wide: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_VIEWPORT_QUERY);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

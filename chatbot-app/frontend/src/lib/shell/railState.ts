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
 * The persisted collapsed flag.
 *
 * @returns `true` only when the stored value is exactly `"true"`. Anything else — unset, a stale value
 *   from an older encoding, storage disabled by policy — means expanded, which is the state that shows
 *   the most information and therefore the right one to fall back to.
 */
export function readRailCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === "true";
  } catch {
    // Storage can throw (private mode with quota 0, a sandboxed iframe). Losing the preference is fine;
    // losing the rail is not.
    return false;
  }
}

/**
 * Persist the collapsed flag.
 *
 * @param collapsed the new state. Swallows storage errors for the same reason `readRailCollapsed` does.
 */
export function writeRailCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // See readRailCollapsed.
  }
}

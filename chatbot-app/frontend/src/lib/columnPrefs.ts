/**
 * Which columns a given person wants to see in a given table, and in what order.
 *
 * Stored in `localStorage`, keyed by the app, the viewer's OIDC subject and the table id. The subject is
 * in the key for one reason: a trading floor shares browsers. Without it, one analyst hiding six columns
 * silently rearranges the table for whoever sits down next, and the second person has no way to tell
 * that what they are looking at is someone else's layout rather than the product's. The app is in the
 * key because both apps' DataTables use this module and choose their table ids independently; see
 * `keyFor`.
 *
 * A layout is not a security control — it decides nothing about what the server will return — so the
 * failure direction here is deliberately the opposite of the email code's: unreadable stored state falls
 * back to the defaults instead of raising, because the alternative is a blank table for a person who did
 * nothing wrong. What is NOT tolerated is an absent subject, which would collapse every viewer onto one
 * shared key and reintroduce the leak this module exists to prevent.
 */

import type { AppId } from "@/lib/auth/apps";

/** One column's stored state. Order within the array IS the column order. */
export interface ColumnPref {
  id: string;
  visible: boolean;
}

/**
 * The `localStorage` key for one person's view of one table in one app.
 *
 * The app segment exists because the two apps' DataTables share this module and pick their own table
 * ids with no coordination: without it, a pipeline table and a recon table that happened to choose the
 * same id ("queue" is a natural name in both) would read and overwrite each other's layout, and
 * `loadColumnPrefs` would then silently drop whichever app's columns it did not recognise, resetting the
 * other app's layout on every save with nothing to explain why.
 *
 * Layouts stored under the pre-shell `recon:cols:<sub>:<tableId>` key are NOT migrated. A column layout
 * falls back to the shipped defaults by design, so the cost of the one-time reset on upgrade is a few
 * clicks, while a migration would mean carrying a second key format for the life of the module.
 *
 * @param appId the app whose table this is.
 * @param tableId stable id of the table within that app, e.g. `"idp-documents"`.
 * @param sub the viewer's OIDC subject.
 * @returns the namespaced storage key, `cols:<appId>:<sub>:<tableId>`.
 */
function keyFor(appId: AppId, tableId: string, sub: string): string {
  return `cols:${appId}:${sub}:${tableId}`;
}

/**
 * Read one person's column layout for a table, reconciled against the columns that exist today.
 *
 * Reconciliation runs in both directions, because a stored layout and a shipped table drift apart on
 * every release: an id that is no longer a column is dropped (it would otherwise hold a slot in the
 * order and shift everything after it), and a column that did not exist when the layout was stored is
 * appended with the visibility its default carries. Appending rather than inserting is the conservative
 * choice — a new column cannot displace a layout someone arranged on purpose.
 *
 * @param appId the app whose table this is.
 * @param tableId stable id of the table.
 * @param sub the viewer's OIDC subject. Empty means the identity has not resolved yet.
 * @param defaults the table's columns in their shipped order, with shipped visibility.
 * @returns the layout to render: the caller's own if one is stored and usable, otherwise `defaults`.
 */
export function loadColumnPrefs(
  appId: AppId,
  tableId: string,
  sub: string,
  defaults: ColumnPref[],
): ColumnPref[] {
  // No subject, no read. The caller renders defaults for one frame and asks again once the app's own
  // `/me` route has answered; guessing a key here is how every viewer ends up sharing one.
  if (!sub) return defaults;
  let raw: string | null = null;
  try {
    raw = globalThis.localStorage?.getItem(keyFor(appId, tableId, sub)) ?? null;
  } catch {
    // Storage can be denied outright (private mode, a blocked third-party context). Not an error worth
    // surfacing to someone reading a reconciliation break or a deal.
    return defaults;
  }
  if (!raw) return defaults;

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (!Array.isArray(stored)) return defaults;

  const known = new Map(defaults.map((d) => [d.id, d]));
  const kept: ColumnPref[] = [];
  const seen = new Set<string>();
  for (const entry of stored) {
    // Each entry is validated on its own rather than trusting the array as a whole: a single hand-edited
    // row should cost that row, not the layout.
    if (!entry || typeof entry !== "object") continue;
    const { id, visible } = entry as { id?: unknown; visible?: unknown };
    if (typeof id !== "string" || typeof visible !== "boolean") continue;
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push({ id, visible });
  }
  if (kept.length === 0) return defaults;

  for (const d of defaults) if (!seen.has(d.id)) kept.push({ ...d });
  return kept;
}

/**
 * Store one person's column layout for a table.
 *
 * @param appId the app whose table this is.
 * @param tableId stable id of the table.
 * @param sub the viewer's OIDC subject. Empty is a no-op, not a shared key.
 * @param prefs the layout to store, in display order.
 * @returns nothing.
 */
export function saveColumnPrefs(
  appId: AppId,
  tableId: string,
  sub: string,
  prefs: ColumnPref[],
): void {
  if (!sub) return;
  try {
    globalThis.localStorage?.setItem(
      keyFor(appId, tableId, sub),
      JSON.stringify(prefs),
    );
  } catch {
    // A quota or a denied store loses the layout for this session. The table still works, and a column
    // arrangement is not worth interrupting the person's actual task over.
  }
}

/**
 * One user's console preferences, shaped from whatever the server sent.
 *
 * Preferences arrive on two paths — inside `/api/me` (`ViewerConsoleFields.preferences`) and from
 * `/api/console/preferences` — and both are typed loosely on purpose: the row is a JSON blob an older
 * build may have written, a proxy may have rewritten, or a user may have edited by hand. Every field is
 * therefore validated before anything acts on it, because two of them steer real behaviour: an unknown
 * `defaultApp` would redirect `/` nowhere, and a `theme` outside the three names next-themes knows
 * would set an unstyled class on `<html>`.
 *
 * No React here so the API client and the viewer store can both import it.
 */

import { APPS, type AppId } from "@/lib/auth/apps";
import type { UserPreferences } from "@/lib/console/types";

/** The theme names the Preferences screen offers and the shell will apply. */
export const THEME_OPTIONS = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_OPTIONS)[number];

function isAppId(value: unknown): value is AppId {
  return typeof value === "string" && APPS.some((a) => a.id === value);
}

function isTheme(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_OPTIONS as readonly string[]).includes(value);
}

/**
 * Keep only the well-typed fields of a preferences body.
 *
 * Absent or malformed fields are DROPPED rather than defaulted: `undefined` means "the user never
 * said", which is a different state from any concrete value — the rail follows the viewport, `/`
 * shows the chooser, the theme stays whatever the browser had.
 *
 * @param raw a `UserPreferences`-shaped body, or anything else.
 */
export function normalizePreferences(raw: unknown): UserPreferences {
  const body = (raw ?? {}) as Record<string, unknown>;
  const out: UserPreferences = {};
  if (isAppId(body.defaultApp)) out.defaultApp = body.defaultApp;
  if (typeof body.railCollapsed === "boolean") out.railCollapsed = body.railCollapsed;
  if (isTheme(body.theme)) out.theme = body.theme;
  return out;
}

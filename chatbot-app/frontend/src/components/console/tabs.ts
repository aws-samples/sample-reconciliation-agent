/**
 * The Settings screen's sections, addressed by `?tab=` so each is linkable and survives a reload.
 *
 * Pure so the choice of section can be tested without rendering: which tab an unknown or missing
 * value falls back to depends on who is looking, and that rule is the kind that quietly rots inside a
 * component.
 */

export type SettingsTabId = "access" | "applications" | "defaults" | "users" | "preferences";

export interface SettingsTab {
  id: SettingsTabId;
  label: string;
  /** One line under the heading. */
  description: string;
  /** Whether the section's data is only readable by console admins (`GET /api/console/settings`). */
  adminData: boolean;
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    id: "access",
    label: "Access",
    description: "Which identity-provider group may use, and which may administer, each application.",
    adminData: true,
  },
  {
    id: "applications",
    label: "Applications",
    description: "Which applications this console serves.",
    adminData: true,
  },
  {
    id: "defaults",
    label: "Defaults",
    description: "Values the applications may inherit, and how this console names itself.",
    adminData: true,
  },
  {
    id: "users",
    label: "Users",
    description: "Who you are to the console, and what a given set of groups would see.",
    adminData: false,
  },
  {
    id: "preferences",
    label: "Preferences",
    description: "Your own defaults: where the console opens, how the rail starts, which theme.",
    adminData: false,
  },
];

export function isSettingsTabId(value: string | null | undefined): value is SettingsTabId {
  return SETTINGS_TABS.some((t) => t.id === value);
}

/**
 * The section to show for a `?tab=` value.
 *
 * A console admin lands on Access, the section the layer exists for. Anyone else lands on
 * Preferences: the admin sections are read-only for them and, without the settings body, mostly
 * placeholders, so opening on one would make the screen look broken rather than restricted.
 *
 * @param param the raw `?tab=` value, or null.
 * @param consoleAdmin whether the viewer is a console admin.
 */
export function resolveSettingsTab(param: string | null | undefined, consoleAdmin: boolean): SettingsTabId {
  if (isSettingsTabId(param)) return param;
  return consoleAdmin ? "access" : "preferences";
}

/** The href of a section, so the nav and any deep link agree on the spelling. */
export function settingsTabHref(id: SettingsTabId): string {
  return `/console/settings?tab=${id}`;
}

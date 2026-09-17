/**
 * Client-side validation and diffing for the console Settings screen.
 *
 * The limits are the shared constants in `lib/console/types.ts`, so what the form refuses is exactly
 * what the PUT would refuse — the point of checking here is a message beside the field instead of a
 * 400 after the round trip, not a different rule. Pure functions so the rules are testable as a
 * table.
 */

import { APPS, type AppId } from "@/lib/auth/apps";
import {
  GROUP_NAME_MAX,
  GROUP_NAME_PATTERN,
  MODEL_ID_PATTERN,
  ORGANIZATION_LABEL_MAX,
  type ConsoleSettings,
  type ConsoleSettingsUpdate,
} from "@/lib/console/types";

/**
 * Why a group name cannot be saved, or `null` when it can.
 *
 * "" is always valid: it is the instruction to clear the stored value and fall back to the
 * environment, not a name.
 */
export function groupNameError(value: string): string | null {
  if (value === "") return null;
  if (value.length > GROUP_NAME_MAX) return `at most ${GROUP_NAME_MAX} characters`;
  if (!GROUP_NAME_PATTERN.test(value)) {
    return "letters, digits, spaces and _ . : @ / - only";
  }
  return null;
}

/** Why a model id cannot be saved, or `null`. "" clears, as for group names. */
export function modelIdError(value: string): string | null {
  if (value === "") return null;
  if (!MODEL_ID_PATTERN.test(value)) return "letters, digits and . _ : / - only, no spaces";
  return null;
}

/** Why an organization label cannot be saved, or `null`. "" clears. */
export function organizationLabelError(value: string): string | null {
  if (value.length > ORGANIZATION_LABEL_MAX) return `at most ${ORGANIZATION_LABEL_MAX} characters`;
  return null;
}

/**
 * The groups an operator typed into the access checker.
 *
 * Comma-separated, whitespace trimmed, blanks dropped, duplicates removed — the same shape a token's
 * group claim has, so the answer describes a user who holds exactly those groups.
 */
export function parseGroupList(input: string): string[] {
  const seen = new Set<string>();
  for (const part of input.split(",")) {
    const name = part.trim();
    if (name) seen.add(name);
  }
  return [...seen];
}

/** The editable text of the Access tab: one pair per app, as the inputs hold them. */
export type AccessDraft = Record<AppId, { accessGroup: string; adminGroup: string }>;

/** The Access tab's inputs as first shown: the RESOLVED values, whatever their source. */
export function accessDraftFrom(settings: ConsoleSettings): AccessDraft {
  const out = {} as AccessDraft;
  for (const app of APPS) {
    const entry = settings.access[app.id];
    out[app.id] = {
      accessGroup: entry?.accessGroup.value ?? "",
      adminGroup: entry?.adminGroup.value ?? "",
    };
  }
  return out;
}

/**
 * Only the fields the operator CHANGED, as a PUT body; `undefined` when nothing changed.
 *
 * The inputs show resolved values, so an untouched field that reads "recon-users" from the
 * environment must not be sent back: writing it would turn an env value into a stored one, and the
 * source chip would flip from "env" to "stored" although nobody asked for that.
 */
export function accessUpdateFrom(
  initial: AccessDraft,
  draft: AccessDraft,
): ConsoleSettingsUpdate | undefined {
  const access: NonNullable<ConsoleSettingsUpdate["access"]> = {};
  let changed = false;
  for (const app of APPS) {
    const before = initial[app.id];
    const after = draft[app.id];
    const entry: { accessGroup?: string; adminGroup?: string } = {};
    if (after.accessGroup !== before.accessGroup) entry.accessGroup = after.accessGroup;
    if (after.adminGroup !== before.adminGroup) entry.adminGroup = after.adminGroup;
    if (Object.keys(entry).length > 0) {
      access[app.id] = entry;
      changed = true;
    }
  }
  return changed ? { access } : undefined;
}

/** The first validation failure across an Access draft, or `null` when it may be saved. */
export function accessDraftError(draft: AccessDraft): string | null {
  for (const app of APPS) {
    const a = groupNameError(draft[app.id].accessGroup);
    if (a) return `${app.label} access group: ${a}`;
    const b = groupNameError(draft[app.id].adminGroup);
    if (b) return `${app.label} admin group: ${b}`;
  }
  return null;
}

/**
 * Validation for the console layer's two write bodies: a settings update and a user's preferences.
 *
 * Pure and SDK-free, so the Settings UI can run the same checks before it sends (and show the same
 * message) without pulling the SSM client into the browser bundle. The server runs them again; a UI
 * that skips them gets a 400 with the message rather than a stored value nothing can read back.
 *
 * Two levels of strictness, on purpose:
 *  - A WRITE is strict. Unknown keys, wrong types and out-of-range values are refused whole, before
 *    anything reaches Parameter Store, because a settings PUT with a typo in one key ("acess") would
 *    otherwise succeed and change nothing, and the operator would be left wondering why the group
 *    they typed does not apply.
 *  - A READ of stored preferences is lenient (`normalizePreferences`). The row was written by an
 *    earlier version of this code or by a hand edit in the SSM console; a field it does not
 *    understand is dropped, never a reason to fail `/api/me` and blank the rail.
 */

import { APPS, appById, type AppId } from "@/lib/auth/apps";

import {
  GROUP_NAME_MAX,
  GROUP_NAME_PATTERN,
  MODEL_ID_MAX,
  MODEL_ID_PATTERN,
  ORGANIZATION_LABEL_MAX,
  PREFERENCE_THEMES,
  type ConsoleSettingsUpdate,
  type UserPreferences,
} from "./types";

/** A body the caller can fix. Routes answer it with 400 and the message verbatim. */
export class ConsoleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleValidationError";
  }
}

/**
 * One planned Parameter Store write. `value: null` means "delete the parameter so the setting falls
 * back to the environment", which is what a "" in the update body asks for.
 */
export interface PlannedWrite {
  /** Parameter name relative to the prefix, e.g. `access/recon/access-group`. */
  key: string;
  value: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Refuse keys the contract does not name, so a typo cannot silently do nothing. */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ConsoleValidationError(`${where}: unknown field "${key}"`);
    }
  }
}

/** A registered app id, or a validation error naming the field. */
function appIdOf(key: string, where: string): AppId {
  const app = appById(key);
  if (!app) {
    throw new ConsoleValidationError(
      `${where}: "${key}" is not a registered application (expected one of ${APPS.map((a) => a.id).join(", ")})`,
    );
  }
  return app.id;
}

/**
 * A group name as the identity provider would spell it, trimmed; "" clears the stored value.
 *
 * Trimmed before the pattern check because the pattern allows interior spaces (Entra display-name
 * groups have them) but a leading or trailing one is never intended, and the registry trims on read
 * anyway, so storing it would only make the Settings screen disagree with the 403 wording.
 */
export function validateGroupName(raw: unknown, where: string): string {
  if (typeof raw !== "string") throw new ConsoleValidationError(`${where}: must be a string`);
  const value = raw.trim();
  if (value === "") return "";
  if (value.length > GROUP_NAME_MAX) {
    throw new ConsoleValidationError(`${where}: must be at most ${GROUP_NAME_MAX} characters`);
  }
  if (!GROUP_NAME_PATTERN.test(value)) {
    throw new ConsoleValidationError(
      `${where}: may contain only letters, digits, spaces and _ . : @ / -`,
    );
  }
  return value;
}

/** A Bedrock model or inference-profile id, trimmed; "" clears the stored value. */
export function validateModelId(raw: unknown, where: string): string {
  if (typeof raw !== "string") throw new ConsoleValidationError(`${where}: must be a string`);
  const value = raw.trim();
  if (value === "") return "";
  if (value.length > MODEL_ID_MAX) {
    throw new ConsoleValidationError(`${where}: must be at most ${MODEL_ID_MAX} characters`);
  }
  if (!MODEL_ID_PATTERN.test(value)) {
    throw new ConsoleValidationError(
      `${where}: may contain only letters, digits and . _ : / -`,
    );
  }
  return value;
}

/**
 * The rail label, trimmed; "" clears the stored value.
 *
 * Any printable text is fine (an organization may well have an apostrophe or an accent in its name),
 * but control characters are refused: a newline in a one-line label is a paste accident, and the rail
 * would render it as a blank.
 */
export function validateOrganizationLabel(raw: unknown, where: string): string {
  if (typeof raw !== "string") throw new ConsoleValidationError(`${where}: must be a string`);
  const value = raw.trim();
  if (value === "") return "";
  if (value.length > ORGANIZATION_LABEL_MAX) {
    throw new ConsoleValidationError(`${where}: must be at most ${ORGANIZATION_LABEL_MAX} characters`);
  }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point.
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new ConsoleValidationError(`${where}: must not contain control characters`);
  }
  return value;
}

/**
 * Validate a `PUT /api/console/settings` body and turn it into the parameter writes it asks for.
 *
 * Validates EVERYTHING before returning anything, so a body with one bad field writes nothing: a
 * half-applied settings change (access group updated, admin group refused) is harder to reason about
 * than a refused one.
 *
 * @param body the parsed JSON body, of unknown shape.
 * @returns the writes, in body order; never empty.
 * @throws ConsoleValidationError naming the field and the rule it broke.
 */
export function planSettingsUpdate(
  body: unknown,
  env: Record<string, string | undefined> = process.env,
): PlannedWrite[] {
  if (!isPlainObject(body)) throw new ConsoleValidationError("body must be a JSON object");
  rejectUnknownKeys(body, ["access", "apps", "defaults"], "body");
  const update = body as ConsoleSettingsUpdate;
  const writes: PlannedWrite[] = [];
  const store = (key: string, value: string) => writes.push({ key, value: value === "" ? null : value });

  if (update.access !== undefined) {
    if (!isPlainObject(update.access)) throw new ConsoleValidationError("access: must be an object");
    for (const [rawId, entry] of Object.entries(update.access)) {
      const id = appIdOf(rawId, "access");
      const where = `access.${id}`;
      if (!isPlainObject(entry)) throw new ConsoleValidationError(`${where}: must be an object`);
      rejectUnknownKeys(entry, ["accessGroup", "adminGroup"], where);
      if (entry.accessGroup !== undefined) {
        store(`access/${id}/access-group`, validateGroupName(entry.accessGroup, `${where}.accessGroup`));
      }
      if (entry.adminGroup !== undefined) {
        store(`access/${id}/admin-group`, validateGroupName(entry.adminGroup, `${where}.adminGroup`));
      }
    }
  }

  if (update.apps !== undefined) {
    if (!isPlainObject(update.apps)) throw new ConsoleValidationError("apps: must be an object");
    for (const [rawId, entry] of Object.entries(update.apps)) {
      const id = appIdOf(rawId, "apps");
      const where = `apps.${id}`;
      if (!isPlainObject(entry)) throw new ConsoleValidationError(`${where}: must be an object`);
      rejectUnknownKeys(entry, ["enabled"], where);
      if (entry.enabled === undefined) continue;
      if (typeof entry.enabled !== "boolean") {
        throw new ConsoleValidationError(`${where}.enabled: must be true or false`);
      }
      // An app with no enablement variable is always part of the console; storing a flag for it would
      // be read by nothing and mislead the next operator into thinking it could be switched off.
      if (appById(id)!.enabledEnv === undefined) {
        throw new ConsoleValidationError(`${where}.enabled: ${appById(id)!.label} cannot be disabled`);
      }
      // Deployment truth outranks the stored layer: an environment value of exactly "false" means the
      // app's resources were never created on this console, so enabling it here would only show an
      // app whose every call fails. The overlay ignores such a stored "true" too; refusing the write
      // tells the admin why instead of silently doing nothing.
      const enabledEnv = appById(id)!.enabledEnv!;
      if (entry.enabled && env[enabledEnv] === "false") {
        throw new ConsoleValidationError(
          `${where}.enabled: ${appById(id)!.label} is not deployed on this console (${enabledEnv} is "false"); enable it in Terraform first`,
        );
      }
      writes.push({ key: `apps/${id}/enabled`, value: entry.enabled ? "true" : "false" });
    }
  }

  if (update.defaults !== undefined) {
    if (!isPlainObject(update.defaults)) throw new ConsoleValidationError("defaults: must be an object");
    rejectUnknownKeys(update.defaults, ["modelId", "organizationLabel"], "defaults");
    if (update.defaults.modelId !== undefined) {
      store("defaults/model-id", validateModelId(update.defaults.modelId, "defaults.modelId"));
    }
    if (update.defaults.organizationLabel !== undefined) {
      store(
        "defaults/organization-label",
        validateOrganizationLabel(update.defaults.organizationLabel, "defaults.organizationLabel"),
      );
    }
  }

  if (writes.length === 0) throw new ConsoleValidationError("nothing to update");
  return writes;
}

/**
 * Parse the `groups` query parameter of `/api/console/access-check` into a trimmed, de-duplicated list.
 *
 * An absent or empty parameter is a legitimate question ("what does a user in NO groups see?"), so it
 * yields `[]` rather than an error. Lives here rather than in the route file because Next's generated
 * route types reject value exports other than the handlers, and the rule deserves a direct test.
 *
 * @param raw the parameter as `URLSearchParams.get` returned it.
 */
export function parseGroupList(raw: string | null): string[] {
  return [...new Set((raw ?? "").split(",").map((g) => g.trim()).filter((g) => g !== ""))];
}

type Theme = UserPreferences["theme"];

function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (PREFERENCE_THEMES as readonly string[]).includes(value);
}

/**
 * Validate a `PUT /api/console/preferences` body (strict).
 *
 * @param raw the parsed JSON body, of unknown shape.
 * @returns the preferences to store, with only the fields that were present.
 * @throws ConsoleValidationError naming the field and the rule it broke.
 */
export function validatePreferences(raw: unknown): UserPreferences {
  if (!isPlainObject(raw)) throw new ConsoleValidationError("body must be a JSON object");
  rejectUnknownKeys(raw, ["defaultApp", "railCollapsed", "theme"], "preferences");
  const out: UserPreferences = {};
  if (raw.defaultApp !== undefined) {
    if (typeof raw.defaultApp !== "string") {
      throw new ConsoleValidationError("preferences.defaultApp: must be a string");
    }
    out.defaultApp = appIdOf(raw.defaultApp, "preferences.defaultApp");
  }
  if (raw.railCollapsed !== undefined) {
    if (typeof raw.railCollapsed !== "boolean") {
      throw new ConsoleValidationError("preferences.railCollapsed: must be true or false");
    }
    out.railCollapsed = raw.railCollapsed;
  }
  if (raw.theme !== undefined) {
    if (!isTheme(raw.theme)) {
      throw new ConsoleValidationError(
        `preferences.theme: must be one of ${PREFERENCE_THEMES.join(", ")}`,
      );
    }
    out.theme = raw.theme;
  }
  return out;
}

/**
 * Shape a stored preferences document (lenient).
 *
 * Whatever is not understood is dropped rather than refused: the row is ours, but it may have been
 * written by a newer or older build or edited by hand, and `/api/me` must still answer.
 *
 * @param raw the parsed JSON, of unknown shape (or undefined when nothing is stored).
 * @returns the fields that are valid; `{}` when none are.
 */
export function normalizePreferences(raw: unknown): UserPreferences {
  if (!isPlainObject(raw)) return {};
  const out: UserPreferences = {};
  if (typeof raw.defaultApp === "string" && appById(raw.defaultApp)) {
    out.defaultApp = raw.defaultApp as AppId;
  }
  if (typeof raw.railCollapsed === "boolean") out.railCollapsed = raw.railCollapsed;
  if (isTheme(raw.theme)) out.theme = raw.theme;
  return out;
}

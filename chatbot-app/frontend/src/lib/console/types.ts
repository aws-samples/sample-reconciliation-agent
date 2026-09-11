/**
 * Console-wide configuration: the layer above the two apps.
 *
 * Decided 2026-09-11. Everything that applies to the console as a whole, rather than to one app,
 * lives here: who may reach which app, which apps are deployed, defaults the apps may inherit, and
 * each user's own preferences. Per-app configuration (thresholds, model choice, contacts...) stays
 * exactly where it is, in each app's Config tab and its own SSM parameters.
 *
 * Storage: AWS Systems Manager Parameter Store, one String parameter per setting under
 * `CONSOLE_SETTINGS_PREFIX` (e.g. `/recon-dev/console`). Layout:
 *
 *   <prefix>/access/<appId>/access-group      IdP group that may use the app ("" = see env/default)
 *   <prefix>/access/<appId>/admin-group       IdP group that administers the app
 *   <prefix>/apps/<appId>/enabled             "true" | "false" (only for apps with enabledEnv)
 *   <prefix>/defaults/model-id                Bedrock model or inference-profile id apps may inherit
 *   <prefix>/defaults/organization-label      label shown under the console mark in the rail
 *   <prefix>/prefs/<sha256(subject) hex, first 32 chars>   JSON UserPreferences for one user
 *
 * Resolution order for every setting: stored value (non-blank) -> environment variable -> default.
 * The stored layer is an OVERLAY on the same environment names the registry already reads
 * (RECON_ACCESS_GROUP, PIPELINE_ENABLED, ...), so `resolveAppAccess` and the admin helpers are
 * unchanged apart from receiving the overlaid env. Three things are deliberately environment-only
 * and can never be changed from the UI: `REQUIRE_ACCESS_GROUPS`, `ALLOW_ANONYMOUS_API` (and its
 * legacy names), and `CONSOLE_ADMIN_GROUP` itself, so a UI edit cannot widen access past what the
 * deployment allows or make someone a console admin.
 *
 * When `CONSOLE_SETTINGS_PREFIX` is unset the layer is disabled: everything resolves from the
 * environment as before, the Settings screens render read-only with an explanatory note, and
 * preferences fall back to the browser (localStorage), which is what the shell did before.
 */

import type { AppId } from "@/lib/auth/apps";

/** Where a resolved value came from, shown beside each field so operators can tell env from UI. */
export type SettingSource = "stored" | "env" | "default";

export interface ResolvedSetting {
  value: string;
  source: SettingSource;
  /** The environment variable that would supply this value when nothing is stored. */
  envName?: string;
}

export interface AppAccessSettings {
  accessGroup: ResolvedSetting;
  adminGroup: ResolvedSetting;
}

export interface AppEnablementSetting {
  /** Resolved "true"/"false"; apps without an `enabledEnv` are always enabled and omitted here. */
  enabled: ResolvedSetting;
}

export interface ConsoleDefaults {
  /** Bedrock model or inference-profile id an app may inherit when its own parameter is blank. */
  modelId: ResolvedSetting;
  /** Shown under the console mark in the rail and on the chooser. */
  organizationLabel: ResolvedSetting;
}

/** Environment-only switches, reported for transparency, never writable through the API. */
export interface EnvOnlySettings {
  requireAccessGroups: boolean;
  anonymousMode: boolean;
  consoleAdminGroup: string;
}

/** GET /api/console/settings (console admins only). */
export interface ConsoleSettings {
  /** False when CONSOLE_SETTINGS_PREFIX is unset; every field then reads from env/default. */
  configured: boolean;
  prefix: string | null;
  access: Record<AppId, AppAccessSettings>;
  apps: Partial<Record<AppId, AppEnablementSetting>>;
  defaults: ConsoleDefaults;
  envOnly: EnvOnlySettings;
  /** ISO time of the last successful PUT, when known. */
  updatedAt?: string;
  updatedBy?: string;
}

/**
 * PUT /api/console/settings body (console admins only). Every field is optional; only the fields
 * present are written. A value of "" clears the stored parameter so the setting falls back to env.
 */
export interface ConsoleSettingsUpdate {
  access?: Partial<Record<AppId, { accessGroup?: string; adminGroup?: string }>>;
  apps?: Partial<Record<AppId, { enabled?: boolean }>>;
  defaults?: { modelId?: string; organizationLabel?: string };
}

/** GET /api/console/access-check?groups=a,b (console admins only): what a hypothetical user would see. */
export interface AccessCheckResult {
  groups: string[];
  apps: Record<AppId, { access: boolean; admin: boolean }>;
  consoleAdmin: boolean;
}

/** One user's preferences: GET/PUT /api/console/preferences (any authenticated user, own row only). */
export interface UserPreferences {
  /** App to open from `/` when the user may use several; ignored when not accessible. */
  defaultApp?: AppId;
  /** Persisted rail state; the browser value is used until this loads. */
  railCollapsed?: boolean;
  theme?: "system" | "light" | "dark";
}

/** Additions the shell reads from `/api/me` beside the existing Viewer fields. */
export interface ViewerConsoleFields {
  console: {
    /** Member of CONSOLE_ADMIN_GROUP (or anonymous mode). Gates the Settings screens' edit mode. */
    admin: boolean;
    /** Whether the SSM layer is configured; false = read-only Settings, browser-only preferences. */
    configured: boolean;
    organizationLabel: string;
  };
  preferences: UserPreferences;
}

/** Validation limits shared by the API and the UI. */
export const GROUP_NAME_MAX = 128;
export const GROUP_NAME_PATTERN = /^[A-Za-z0-9 _.:@/-]+$/;
export const ORGANIZATION_LABEL_MAX = 60;
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]+$/;
/**
 * Upper bound on a model id. `MODEL_ID_PATTERN` has no length limit of its own, and an SSM String
 * parameter would happily hold kilobytes; a Bedrock inference-profile ARN is under 200 characters.
 */
export const MODEL_ID_MAX = 256;

/**
 * Environment names the console layer itself reads. Kept here, beside the types, so the Settings UI
 * can name them in its read-only notes without importing the server module (which pulls in the SSM
 * SDK).
 */
/** Where the stored layer lives; unset or blank disables it. */
export const CONSOLE_SETTINGS_PREFIX_ENV = "CONSOLE_SETTINGS_PREFIX";
/** Environment fallback for `<prefix>/defaults/organization-label`. */
export const CONSOLE_ORGANIZATION_LABEL_ENV = "CONSOLE_ORGANIZATION_LABEL";
/** Environment fallback for `<prefix>/defaults/model-id`. */
export const CONSOLE_DEFAULT_MODEL_ID_ENV = "CONSOLE_DEFAULT_MODEL_ID";
/** What the rail shows when neither the stored label nor the environment names one. */
export const DEFAULT_ORGANIZATION_LABEL = "Agentic Operations Console";

/** The `theme` values `UserPreferences` accepts, as a runtime list so the validator and the UI agree. */
export const PREFERENCE_THEMES = ["system", "light", "dark"] as const;

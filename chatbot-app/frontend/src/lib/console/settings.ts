/**
 * The console-wide configuration layer: stored settings in Parameter Store, overlaid on the
 * environment the app registry already reads.
 *
 * See `types.ts` for the contract (layout, resolution order, what is environment-only). This module
 * is the only place that talks to SSM for the console; every reader of "who may reach what" goes
 * through `effectiveEnv()` and hands the result to the registry's unchanged functions.
 *
 * Failure policy. The proxy asks this module on EVERY BFF request, so a Parameter Store hiccup
 * (throttling, a NAT blip in `private_vpc` mode, a missing IAM grant after a deploy) would otherwise
 * turn into a console-wide outage. Instead the layer fails OPEN TO THE ENVIRONMENT: when the prefix
 * is unset or the read fails, `effectiveEnv()` returns `process.env`, which is exactly what every
 * consumer read before this layer existed and what the deployment's own Terraform still sets. The
 * failure is logged once per cache window rather than once per request, because a log line per BFF
 * call during a 30-second throttle is noise that hides the one line that matters. The trade-off is
 * stated plainly: for the length of one cache window after a failure, a group restriction that
 * exists only in the stored layer is not enforced. Deployments that cannot accept that must also set
 * the group in the environment, which the stored value then merely overrides.
 *
 * Cache. One in-process snapshot with a 30-second TTL, shared by every caller, with a single
 * in-flight read so a burst of requests after expiry costs one SSM call. `invalidate()` drops it
 * after a write so the admin who just saved sees the result on the next read. PROPAGATION BETWEEN
 * INSTANCES RELIES ON THE TTL: a second ECS task, or Next's separately bundled proxy in the same
 * task, learns about a change within 30 seconds. There is no cross-instance signal by design; the
 * settings change rarely and a 30-second lag on an access-group edit is acceptable where a
 * message bus would not be worth its own failure modes.
 */

import { createHash } from "node:crypto";

import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";

import { isAnonymousEnabled } from "@/lib/api-auth";
import {
  APPS,
  CONSOLE_ADMIN_GROUP_ENV,
  accessGroupsRequired,
  isAppEnabled,
  type AppId,
  type Env,
} from "@/lib/auth/apps";

import { consoleSsm } from "./ssm";
import {
  CONSOLE_DEFAULT_MODEL_ID_ENV,
  CONSOLE_ORGANIZATION_LABEL_ENV,
  CONSOLE_SETTINGS_PREFIX_ENV,
  DEFAULT_ORGANIZATION_LABEL,
  type AppAccessSettings,
  type AppEnablementSetting,
  type ConsoleDefaults,
  type ConsoleSettings,
  type ResolvedSetting,
  type UserPreferences,
} from "./types";
import { normalizePreferences, planSettingsUpdate, validatePreferences } from "./validation";

/** How long a snapshot of the stored layer is served before Parameter Store is asked again. */
export const OVERLAY_TTL_MS = 30_000;

/** Thrown by writes when `CONSOLE_SETTINGS_PREFIX` is unset. Routes answer it with 409. */
export class ConsoleNotConfiguredError extends Error {
  constructor() {
    super(
      `console settings are not configured on this deployment: set ${CONSOLE_SETTINGS_PREFIX_ENV} ` +
        "to a Parameter Store path to enable them",
    );
    this.name = "ConsoleNotConfiguredError";
  }
}

/**
 * The Parameter Store path the layer lives under, or "" when the layer is disabled.
 *
 * Trimmed, and trailing slashes removed, so `/x/console/` and `/x/console` name the same tree and
 * the parameter names built from it never contain `//`. Blank reads as unset for the same reason
 * every other blank variable in this codebase does: a task definition that declares the variable
 * empty must behave like one that omits it.
 *
 * @param env process environment to read from (injected in tests).
 */
export function consoleSettingsPrefix(env: Env = process.env): string {
  return (env[CONSOLE_SETTINGS_PREFIX_ENV] ?? "").trim().replace(/\/+$/, "");
}

/** Whether the stored layer is enabled on this deployment. */
export function isConsoleConfigured(env: Env = process.env): boolean {
  return consoleSettingsPrefix(env) !== "";
}

/**
 * Whether a caller's groups include the console admin group.
 *
 * Read from the ENVIRONMENT, never from the overlay: this is the one group a UI edit must not be able
 * to grant, so the stored layer is never consulted for it (see `types.ts`). Blank means nobody, the
 * same fail-closed reading the app admin helpers use; anonymous local mode holds the group through
 * `allConfiguredGroups`, so a laptop with `CONSOLE_ADMIN_GROUP` set sees the Settings screens in edit
 * mode.
 *
 * @param groups the caller's verified group memberships.
 * @param env process environment to read `CONSOLE_ADMIN_GROUP` from (injected in tests).
 */
export function isConsoleAdmin(groups: readonly string[], env: Env = process.env): boolean {
  const required = consoleAdminGroup(env);
  return required !== "" && groups.includes(required);
}

/** The console admin group, trimmed, or "" when unset or blank. */
export function consoleAdminGroup(env: Env = process.env): string {
  return env[CONSOLE_ADMIN_GROUP_ENV]?.trim() ?? "";
}

/**
 * Stored parameters, keyed by their name RELATIVE to the prefix (`access/recon/access-group`),
 * values trimmed, blanks dropped. Relative keys keep every mapping below independent of where the
 * operator chose to put the tree.
 */
export type StoredSettings = Record<string, string>;

/** The subtrees a settings read fetches. `prefs/` is excluded on purpose: one row per user, unbounded. */
const SETTINGS_SUBTREES = ["access", "apps", "defaults", "meta"] as const;

/**
 * Read every parameter under one path, following pagination.
 *
 * `GetParametersByPath` returns at most ten parameters per page whatever `MaxResults` says, so even
 * this small tree can span two pages once both apps have both groups set and the defaults are in.
 */
async function readSubtree(path: string, into: StoredSettings, prefix: string): Promise<void> {
  let nextToken: string | undefined;
  do {
    const page = await consoleSsm().send(
      new GetParametersByPathCommand({ Path: path, Recursive: true, NextToken: nextToken }),
    );
    for (const parameter of page.Parameters ?? []) {
      const name = parameter.Name ?? "";
      const value = parameter.Value?.trim() ?? "";
      // A blank stored value means "fall back to env", exactly like an unset one; dropping it here is
      // what makes the resolution order in types.ts hold without every reader re-checking.
      if (!name.startsWith(`${prefix}/`) || value === "") continue;
      into[name.slice(prefix.length + 1)] = value;
    }
    nextToken = page.NextToken;
  } while (nextToken);
}

/** Fetch the whole settings tree (not preferences) from Parameter Store. Throws on any SDK failure. */
async function readStored(prefix: string): Promise<StoredSettings> {
  const stored: StoredSettings = {};
  for (const subtree of SETTINGS_SUBTREES) {
    await readSubtree(`${prefix}/${subtree}`, stored, prefix);
  }
  return stored;
}

interface Snapshot {
  stored: StoredSettings;
  /** `Date.now()` after which the snapshot is stale. */
  expiresAt: number;
}

let snapshot: Snapshot | null = null;
let inflight: Promise<StoredSettings> | null = null;

/**
 * The stored layer as of the last successful read within the TTL, or `{}` when the layer is
 * disabled or the read failed (logged once per window).
 */
async function cachedStored(): Promise<StoredSettings> {
  const prefix = consoleSettingsPrefix();
  if (prefix === "") return {};
  const now = Date.now();
  if (snapshot && snapshot.expiresAt > now) return snapshot.stored;
  if (inflight) return inflight;
  inflight = readStored(prefix)
    .then((stored) => {
      snapshot = { stored, expiresAt: Date.now() + OVERLAY_TTL_MS };
      return stored;
    })
    .catch((err: unknown) => {
      // Prefer the last snapshot we did read: a restriction that lives only in the stored layer must
      // not lapse because Parameter Store hiccupped. Only a process that has never read the layer
      // falls back to the environment. Either way the failure is cached for one window, so a
      // throttled Parameter Store is not asked again on every request while it recovers.
      const detail = err instanceof Error ? err.message : String(err);
      const stale = snapshot?.stored;
      console.warn(
        `[console-settings] could not read ${prefix}: ${detail}. ` +
          (stale ? "Serving the last snapshot" : "Resolving from the environment") +
          ` for the next ${OVERLAY_TTL_MS / 1000}s.`,
      );
      snapshot = { stored: stale ?? {}, expiresAt: Date.now() + OVERLAY_TTL_MS };
      return stale ?? {};
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Forget the cached snapshot so the next read asks Parameter Store. Called after every write. */
export function invalidate(): void {
  snapshot = null;
}

/**
 * Map stored parameters onto the environment names the registry reads.
 *
 * Only the access and apps subtrees have an environment twin; defaults and meta are read by their
 * own accessors. Exported pure so the precedence rule is testable without a client.
 *
 * @param stored parameters keyed relative to the prefix.
 */
export function overlayFromStored(
  stored: StoredSettings,
  env: Env = process.env,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const app of APPS) {
    const access = stored[`access/${app.id}/access-group`];
    if (access) overlay[app.accessGroupEnv] = access;
    const admin = stored[`access/${app.id}/admin-group`];
    if (admin) overlay[app.adminGroupEnv] = admin;
    if (app.enabledEnv) {
      // Deployment truth wins over the stored layer here: an env value of exactly "false" means the
      // app's tables, bucket and grants do not exist on this console, so a stored "true" would only
      // show an app that 500s. Terraform seeds "false" for that case and the UI refuses to flip it.
      const enabled = stored[`apps/${app.id}/enabled`];
      if (enabled && env[app.enabledEnv] !== "false") overlay[app.enabledEnv] = enabled;
    }
  }
  return overlay;
}

/**
 * The stored values that override environment variables, as `{ ENV_NAME: value }`.
 *
 * @returns an empty object when the layer is disabled or unreadable.
 */
export async function loadOverlay(): Promise<Record<string, string>> {
  return overlayFromStored(await cachedStored());
}

/**
 * The environment every access decision should read: the process environment with the stored layer
 * on top.
 *
 * Returns `process.env` itself (not a copy) when the layer is disabled, so a deployment without the
 * prefix pays nothing and behaves byte-for-byte as before.
 */
export async function effectiveEnv(): Promise<Env> {
  if (!isConsoleConfigured()) return process.env;
  const overlay = await loadOverlay();
  return { ...process.env, ...overlay };
}

/** Resolve one string setting: stored -> env -> default. */
function resolve(
  storedValue: string | undefined,
  envName: string,
  env: Env,
  fallback: string,
): ResolvedSetting {
  if (storedValue) return { value: storedValue, source: "stored", envName };
  const fromEnv = env[envName]?.trim() ?? "";
  if (fromEnv) return { value: fromEnv, source: "env", envName };
  return { value: fallback, source: "default", envName };
}

/** Resolve one app's enablement flag, reporting "true"/"false" whatever the raw value spelled. */
function resolveEnabled(stored: StoredSettings, appId: AppId, envName: string, env: Env): ResolvedSetting {
  // Deployment truth first: exactly "false" in the environment means not deployed, whatever is stored
  // (mirrors `overlayFromStored`, so the screen shows what the proxy enforces).
  if (env[envName] === "false") return { value: "false", source: "env", envName };
  const storedValue = stored[`apps/${appId}/enabled`];
  if (storedValue) {
    return { value: isAppEnabled(appId, { [envName]: storedValue }) ? "true" : "false", source: "stored", envName };
  }
  if ((env[envName]?.trim() ?? "") !== "") {
    return { value: isAppEnabled(appId, env) ? "true" : "false", source: "env", envName };
  }
  return { value: "true", source: "default", envName };
}

/** `{at, by}` from `meta/updated`, or nothing when absent or unparseable (a hand edit must not 500 the screen). */
function updatedMeta(stored: StoredSettings): { updatedAt?: string; updatedBy?: string } {
  const raw = stored["meta/updated"];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as { at?: unknown; by?: unknown };
    return {
      ...(typeof parsed.at === "string" ? { updatedAt: parsed.at } : {}),
      ...(typeof parsed.by === "string" ? { updatedBy: parsed.by } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * The console defaults: stored -> env -> default for each.
 *
 * Separate from `settingsFrom` because `/api/me` and the pipeline's config route need only these,
 * on every page load, and must not pay for (or depend on) the rest of the settings view.
 */
export function defaultsFrom(stored: StoredSettings, env: Env = process.env): ConsoleDefaults {
  return {
    modelId: resolve(stored["defaults/model-id"], CONSOLE_DEFAULT_MODEL_ID_ENV, env, ""),
    organizationLabel: resolve(
      stored["defaults/organization-label"],
      CONSOLE_ORGANIZATION_LABEL_ENV,
      env,
      DEFAULT_ORGANIZATION_LABEL,
    ),
  };
}

/** Build the `ConsoleSettings` view from a stored snapshot and the process environment. */
export function settingsFrom(stored: StoredSettings, env: Env = process.env): ConsoleSettings {
  const prefix = consoleSettingsPrefix(env);
  const access = {} as Record<AppId, AppAccessSettings>;
  const apps: Partial<Record<AppId, AppEnablementSetting>> = {};
  for (const app of APPS) {
    access[app.id] = {
      accessGroup: resolve(stored[`access/${app.id}/access-group`], app.accessGroupEnv, env, ""),
      adminGroup: resolve(stored[`access/${app.id}/admin-group`], app.adminGroupEnv, env, ""),
    };
    if (app.enabledEnv) {
      apps[app.id] = { enabled: resolveEnabled(stored, app.id, app.enabledEnv, env) };
    }
  }
  return {
    configured: prefix !== "",
    prefix: prefix === "" ? null : prefix,
    access,
    apps,
    defaults: defaultsFrom(stored, env),
    // Environment-only switches read from the process environment on purpose: the overlay never
    // carries them, and reporting them from anywhere else would suggest they could be stored.
    envOnly: {
      requireAccessGroups: accessGroupsRequired(env),
      anonymousMode: isAnonymousEnabled(env),
      consoleAdminGroup: consoleAdminGroup(env),
    },
    ...updatedMeta(stored),
  };
}

/**
 * The full settings view for the Settings screen.
 *
 * Reads Parameter Store FRESH rather than from the cache, and refreshes the cache with what it
 * finds: this is an admin looking at the truth, rarely, and a stale answer here (another instance
 * wrote ten seconds ago) would make the screen disagree with what they just saved. Unlike the
 * access path this does NOT fail open: an admin must see the read error, not a screen that claims
 * every field comes from the environment.
 */
export async function getConsoleSettings(): Promise<ConsoleSettings> {
  const prefix = consoleSettingsPrefix();
  if (prefix === "") return settingsFrom({});
  const stored = await readStored(prefix);
  snapshot = { stored, expiresAt: Date.now() + OVERLAY_TTL_MS };
  return settingsFrom(stored);
}

/** Delete one parameter, treating "already absent" as success: clearing a setting twice is not an error. */
async function deleteParameter(name: string): Promise<void> {
  try {
    await consoleSsm().send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if ((err as { name?: string }).name !== "ParameterNotFound") throw err;
  }
}

/** Write one String parameter, creating or overwriting. */
async function putParameter(name: string, value: string): Promise<void> {
  await consoleSsm().send(
    new PutParameterCommand({ Name: name, Value: value, Type: "String", Overwrite: true }),
  );
}

/**
 * Apply a settings update.
 *
 * Validates the whole body first (nothing is written when any field is bad), then writes each
 * present field, deletes each cleared one, records who did it and when in `meta/updated`, and drops
 * the cache. Returns the refreshed view so the PUT route can answer with what is now in effect.
 *
 * @param body the parsed `ConsoleSettingsUpdate`, of unknown shape until validated.
 * @param actor the verified subject making the change, for `updatedBy`.
 * @throws ConsoleNotConfiguredError when the layer is disabled; ConsoleValidationError on a bad body.
 */
export async function updateConsoleSettings(body: unknown, actor: string): Promise<ConsoleSettings> {
  const prefix = consoleSettingsPrefix();
  if (prefix === "") throw new ConsoleNotConfiguredError();
  const writes = planSettingsUpdate(body);
  for (const write of writes) {
    const name = `${prefix}/${write.key}`;
    if (write.value === null) await deleteParameter(name);
    else await putParameter(name, write.value);
  }
  await putParameter(
    `${prefix}/meta/updated`,
    JSON.stringify({ at: new Date().toISOString(), by: actor }),
  );
  invalidate();
  return getConsoleSettings();
}

/**
 * The rail label in effect: stored -> `CONSOLE_ORGANIZATION_LABEL` -> the default.
 *
 * From the cache, because `/api/me` asks on every page load.
 */
export async function organizationLabel(): Promise<string> {
  return defaultsFrom(await cachedStored()).organizationLabel.value;
}

/**
 * The console-wide default model id an app may inherit, or null when none is set anywhere.
 *
 * Stored -> `CONSOLE_DEFAULT_MODEL_ID` -> null. Not filtered against any app's allowlist: which ids an
 * app accepts is that app's business, and returning the raw value lets its Config tab explain "the
 * console default is X, which this app does not offer" instead of silently hiding the button.
 */
export async function consoleDefaultModelId(): Promise<string | null> {
  return defaultsFrom(await cachedStored()).modelId.value || null;
}

/**
 * The parameter that holds one user's preferences.
 *
 * The subject is hashed rather than used verbatim: an OIDC `sub` can contain characters Parameter
 * Store names refuse, and a parameter listing that spelled out every user's identifier would be a
 * roster. SHA-256 truncated to 128 bits is more than enough to keep two subjects apart and keeps the
 * name well inside SSM's length limit.
 *
 * @param subject the verified `sub` claim (or "anonymous").
 * @param prefix the console prefix (injected in tests).
 */
export function preferencesParameterName(subject: string, prefix: string = consoleSettingsPrefix()): string {
  const digest = createHash("sha256").update(subject, "utf8").digest("hex").slice(0, 32);
  return `${prefix}/prefs/${digest}`;
}

/**
 * One user's stored preferences.
 *
 * @returns `{}` when the layer is disabled, when nothing is stored for the subject, or when the
 *   stored document is not valid JSON (a hand edit must not blank the rail).
 */
export async function getPreferences(subject: string): Promise<UserPreferences> {
  const prefix = consoleSettingsPrefix();
  if (prefix === "") return {};
  try {
    const got = await consoleSsm().send(
      new GetParameterCommand({ Name: preferencesParameterName(subject, prefix) }),
    );
    return normalizePreferences(JSON.parse(got.Parameter?.Value ?? "{}"));
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound" || err instanceof SyntaxError) return {};
    throw err;
  }
}

/**
 * Replace one user's stored preferences.
 *
 * PUT semantics, whole document: the client holds the full object (it arrived in `/api/me`) and sends
 * it back changed, which is simpler to reason about than a merge whose "unset this field" case would
 * need a sentinel.
 *
 * @param subject the verified `sub` claim; a user can only ever write their own row because the
 *   routes take it from the token, never from the body.
 * @param body the parsed body, validated strictly here.
 * @returns the preferences as stored.
 * @throws ConsoleNotConfiguredError when the layer is disabled; ConsoleValidationError on a bad body.
 */
export async function putPreferences(subject: string, body: unknown): Promise<UserPreferences> {
  const prefix = consoleSettingsPrefix();
  if (prefix === "") throw new ConsoleNotConfiguredError();
  const prefs = validatePreferences(body);
  await putParameter(preferencesParameterName(subject, prefix), JSON.stringify(prefs));
  return prefs;
}

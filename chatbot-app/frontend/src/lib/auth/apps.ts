/**
 * The application registry: which apps exist, where they live, whether they are deployed, and which
 * identity-provider groups grant access to and administration of each.
 *
 * Shared by the proxy (per-app API access), the `/api/me` route (what the shell may show), the
 * landing page, the app rail, and the two admin helpers (`reconAdmin.ts`, `pipelineAdmin.ts`). Adding
 * an app is one entry here plus its own route trees; nothing else in the shell needs to change.
 *
 * Access model (decided 2026-09-11): permissions come from the IdP group claim the existing auth
 * already reads. Each app has an ACCESS group ("may use it") and an ADMIN group ("may change its
 * configuration and approve"); admins implicitly have access. Three environment switches shape the
 * decision, and every consumer reads them through this module so they cannot disagree:
 *
 *  - `<APP>_ACCESS_GROUP` / `<APP>_ADMIN_GROUP`: the group names, TRIMMED (`accessGroupFor`,
 *    `adminGroupFor`). A padded value in a tfvars file must not make `/api/me` say "admin" while
 *    every write route answers 403; both sides read the same trimmed string, and a blank value reads
 *    as unset everywhere.
 *  - `REQUIRE_ACCESS_GROUPS`: exactly "true" turns an UNSET access group from "open to every
 *    authenticated user" into "denied to everyone but the app's admins". The open default preserves
 *    the behaviour deployments had before the shell existed and is right while ONE app owns the OIDC
 *    client. It stops being right the moment a second app joins: "every authenticated user" then
 *    includes the other app's whole desk, and recon has write routes (system prompt, skills, harness
 *    configs) that rely on the access group as their only gate. So the composed deployment sets this
 *    to "true", and Terraform refuses a plan that enables the pipeline without naming both groups.
 *  - `enabledEnv` (per app, optional): exactly "false" means the app is not deployed. A disabled app
 *    is hidden from the rail and the chooser and its API prefix answers 403, whatever groups the
 *    caller holds. Unset or any other value means enabled, so local dev needs no extra variable, and
 *    an app with no `enabledEnv` (recon) is always part of the console.
 */

export type AppId = "recon" | "pipeline";

export interface AppDefinition {
  id: AppId;
  /** Human label shown in the rail and the chooser. */
  label: string;
  /** One-line description for the chooser. */
  description: string;
  /** Where the rail sends the user. */
  href: string;
  /** Route-tree prefix used to highlight the active app. */
  pathPrefix: string;
  /** BFF prefix the proxy protects with this app's access group. */
  apiPrefix: string;
  /**
   * Env var naming the IdP group that may use the app. Unset or blank means open to every
   * authenticated user, unless `REQUIRE_ACCESS_GROUPS` is "true", in which case it means admins only.
   */
  accessGroupEnv: string;
  /** Env var naming the IdP group that administers the app. */
  adminGroupEnv: string;
  /**
   * Env var that says whether the app is deployed: exactly "false" disables it, anything else (or
   * unset) enables it. Omitted for an app that is always part of the console.
   */
  enabledEnv?: string;
}

export const APPS: readonly AppDefinition[] = [
  {
    id: "recon",
    label: "Trade Reconciliation",
    description: "Triage, investigate and resolve reconciliation breaks with an agent in the loop.",
    href: "/recon/dashboard",
    pathPrefix: "/recon",
    apiPrefix: "/api/recon",
    accessGroupEnv: "RECON_ACCESS_GROUP",
    adminGroupEnv: "RECON_ADMIN_GROUP",
  },
  {
    id: "pipeline",
    label: "Deal Pipeline",
    description: "Turn new-issue deal emails into OMS staging records, reviewed before upload.",
    href: "/pipeline/inbox",
    pathPrefix: "/pipeline",
    apiPrefix: "/api/pipeline",
    accessGroupEnv: "PIPELINE_ACCESS_GROUP",
    adminGroupEnv: "PIPELINE_ADMIN_GROUP",
    // The pipeline is an opt-in deployment (`enable_deal_pipeline` in Terraform). Without this flag
    // a recon-only console would list and serve an app whose tables do not exist.
    enabledEnv: "PIPELINE_ENABLED",
  },
] as const;

export interface AppAccess {
  access: boolean;
  admin: boolean;
}

/** What `/api/me` returns and the shell consumes. */
export interface Viewer {
  subject: string;
  groups: string[];
  mode: "anonymous" | "okta" | "entra";
  apps: Record<AppId, AppAccess>;
}

/** The environment shape every reader here accepts, so tests can inject one instead of mutating `process.env`. */
export type Env = Record<string, string | undefined>;

/**
 * Env var naming the IdP group that administers the CONSOLE: who may change the stored access
 * groups, app enablement and console defaults through the Settings screens (`lib/console`).
 *
 * Environment-only by design. The console layer overlays stored values onto the per-app names above,
 * but never onto this one: a UI edit must not be able to make someone a console admin, so the group
 * that gates the UI can only come from the deployment.
 */
export const CONSOLE_ADMIN_GROUP_ENV = "CONSOLE_ADMIN_GROUP";

const APP_BY_ID = Object.fromEntries(APPS.map((a) => [a.id, a])) as Record<AppId, AppDefinition>;

export function appById(id: string): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
}

/** Accept either the definition or its id, so the admin helpers can name their app with a literal. */
function definitionOf(app: AppDefinition | AppId): AppDefinition {
  return typeof app === "string" ? APP_BY_ID[app] : app;
}

/** The app whose API prefix owns this request path, if any. */
export function appForApiPath(pathname: string): AppDefinition | undefined {
  return APPS.find((a) => pathname === a.apiPrefix || pathname.startsWith(`${a.apiPrefix}/`));
}

/** The app whose page tree owns this path, if any. */
export function appForPagePath(pathname: string): AppDefinition | undefined {
  return APPS.find((a) => pathname === a.pathPrefix || pathname.startsWith(`${a.pathPrefix}/`));
}

/**
 * One group variable, trimmed, or "" when unset or blank.
 *
 * Blank reads as unset on purpose: a task definition that declares the variable with an empty value
 * must behave like one that omits it, not lock everyone out (access) or admit a caller in a group
 * literally named "" (admin).
 */
function trimmedGroup(name: string, env: Env): string {
  return env[name]?.trim() ?? "";
}

/**
 * The configured ACCESS group of an app, trimmed, or "" when none is configured.
 *
 * @param app the app, by definition or id.
 * @param env process environment to read from (injected in tests).
 */
export function accessGroupFor(app: AppDefinition | AppId, env: Env = process.env): string {
  return trimmedGroup(definitionOf(app).accessGroupEnv, env);
}

/**
 * The configured ADMIN group of an app, trimmed, or "" when none is configured.
 *
 * The single source for `resolveAppAccess`, `isReconAdmin`, `isPipelineAdmin` and their 403 wording,
 * so the rail's admin chip and the write routes can never disagree about the group's spelling.
 *
 * @param app the app, by definition or id.
 * @param env process environment to read from (injected in tests).
 */
export function adminGroupFor(app: AppDefinition | AppId, env: Env = process.env): string {
  return trimmedGroup(definitionOf(app).adminGroupEnv, env);
}

/**
 * Whether an app is deployed on this console.
 *
 * Only the literal "false" disables. Not a truthy check, and not trimmed or case-folded: the value is
 * rendered by Terraform from a bool, and a deployment that has never heard of the variable (every
 * recon-only deployment that predates it, every laptop) must stay enabled.
 *
 * @param app the app, by definition or id.
 * @param env process environment to read from (injected in tests).
 */
export function isAppEnabled(app: AppDefinition | AppId, env: Env = process.env): boolean {
  const name = definitionOf(app).enabledEnv;
  return name === undefined || env[name] !== "false";
}

/**
 * Whether an unset access group means "admins only" rather than "everyone".
 *
 * Exactly "true", never a truthy check, for the same reason as the anonymous switch: a generic
 * variable must not be able to flip the access model by accident in either direction.
 *
 * @param env process environment to read from (injected in tests).
 */
export function accessGroupsRequired(env: Env = process.env): boolean {
  return env.REQUIRE_ACCESS_GROUPS === "true";
}

/**
 * Resolve a caller's per-app access from the groups the token (or anonymous mode) carried.
 *
 * A disabled app resolves to no access and no admin for everyone, including its admins: there is
 * nothing deployed to administer, and reporting `admin: true` would make the rail show a chip for an
 * app it must not list.
 *
 * @param groups verified group memberships.
 * @param env process environment to read the group names and switches from (injected in tests).
 */
export function resolveAppAccess(
  groups: readonly string[],
  env: Env = process.env,
): Record<AppId, AppAccess> {
  const out = {} as Record<AppId, AppAccess>;
  for (const app of APPS) {
    if (!isAppEnabled(app, env)) {
      out[app.id] = { access: false, admin: false };
      continue;
    }
    const accessGroup = accessGroupFor(app, env);
    const adminGroup = adminGroupFor(app, env);
    const admin = adminGroup !== "" && groups.includes(adminGroup);
    // No access group configured: open, unless the deployment asked for fail-closed, in which case
    // only the admin group (checked above) gets in.
    const openToAll = accessGroup === "" && !accessGroupsRequired(env);
    const access = admin || openToAll || (accessGroup !== "" && groups.includes(accessGroup));
    out[app.id] = { access, admin };
  }
  return out;
}

/**
 * Every group name the registry knows about, used by anonymous local mode to grant everything.
 *
 * Read through the same trimming accessors as every other consumer, so the anonymous caller holds the
 * exact strings `resolveAppAccess` and the admin helpers compare against. Includes the console admin
 * group for the same reason: a laptop run with `CONSOLE_ADMIN_GROUP` set must see the Settings screens
 * in edit mode without an identity provider, exactly as it sees both apps' Config tabs.
 *
 * @param env process environment to read the group names from.
 */
export function allConfiguredGroups(env: Env = process.env): string[] {
  const names = new Set<string>();
  for (const app of APPS) {
    for (const v of [accessGroupFor(app, env), adminGroupFor(app, env)]) {
      if (v) names.add(v);
    }
  }
  const consoleAdmin = trimmedGroup(CONSOLE_ADMIN_GROUP_ENV, env);
  if (consoleAdmin) names.add(consoleAdmin);
  return [...names];
}

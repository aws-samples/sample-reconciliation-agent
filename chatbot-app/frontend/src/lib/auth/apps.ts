/**
 * The application registry: which apps exist, where they live, and which identity-provider groups
 * grant access to and administration of each.
 *
 * Shared by the proxy (per-app API access), the `/api/me` route (what the shell may show), the
 * landing page, and the app rail. Adding an app is one entry here plus its own route trees; nothing
 * else in the shell needs to change.
 *
 * Access model (decided 2026-09-11): permissions come from the IdP group claim the existing auth
 * already reads. Each app has an ACCESS group ("may use it") and an ADMIN group ("may change its
 * configuration and approve"); admins implicitly have access. An app whose access group is unset
 * stays open to every authenticated user, which preserves the behaviour deployments had before the
 * shell existed; set the group to restrict it.
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
  /** Env var naming the IdP group that may use the app ("" or unset = open to all authenticated). */
  accessGroupEnv: string;
  /** Env var naming the IdP group that administers the app. */
  adminGroupEnv: string;
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

export function appById(id: string): AppDefinition | undefined {
  return APPS.find((a) => a.id === id);
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
 * Resolve a caller's per-app access from the groups the token (or anonymous mode) carried.
 *
 * @param groups verified group memberships.
 * @param env process environment to read the group names from (injected in tests).
 */
export function resolveAppAccess(
  groups: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Record<AppId, AppAccess> {
  const out = {} as Record<AppId, AppAccess>;
  for (const app of APPS) {
    const accessGroup = env[app.accessGroupEnv]?.trim() ?? "";
    const adminGroup = env[app.adminGroupEnv]?.trim() ?? "";
    const admin = adminGroup !== "" && groups.includes(adminGroup);
    const access = admin || accessGroup === "" || groups.includes(accessGroup);
    out[app.id] = { access, admin };
  }
  return out;
}

/**
 * Every group name the registry knows about, used by anonymous local mode to grant everything.
 *
 * @param env process environment to read the group names from.
 */
export function allConfiguredGroups(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const names = new Set<string>();
  for (const app of APPS) {
    for (const key of [app.accessGroupEnv, app.adminGroupEnv]) {
      const v = env[key]?.trim();
      if (v) names.add(v);
    }
  }
  return [...names];
}

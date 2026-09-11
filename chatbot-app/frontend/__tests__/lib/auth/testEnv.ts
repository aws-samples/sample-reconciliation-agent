/**
 * Scoped `process.env` control for the auth tests.
 *
 * `authorizeRequest`, the proxy and `/api/me` read the environment at CALL time by design: the group
 * names and the anonymous switch are runtime deployment facts, which is the whole reason the gate
 * runs on the Node runtime. Tests that exercise them end to end therefore have to set real
 * `process.env` keys. Every auth-related key is cleared first so nothing leaks in from the shell that
 * launched vitest or from a sibling test, and restored afterwards so nothing leaks out.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

import { APPS } from "@/lib/auth/apps";

/** Every environment variable the auth stack reads. Group names come from the registry so the list cannot drift. */
export const AUTH_ENV_NAMES: readonly string[] = [
  "ALLOW_ANONYMOUS_API",
  "RECON_ALLOW_ANONYMOUS_API",
  "PIPELINE_ALLOW_ANONYMOUS_API",
  "ANONYMOUS_GROUPS",
  "REQUIRE_ACCESS_GROUPS",
  ...APPS.flatMap((app) => [app.accessGroupEnv, app.adminGroupEnv]),
  ...APPS.flatMap((app) => (app.enabledEnv ? [app.enabledEnv] : [])),
  "AUTH_GROUPS_CLAIM",
  "AUTH_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  "OKTA_ISSUER",
  "OKTA_CLIENT_ID",
  "NEXT_PUBLIC_OKTA_ISSUER",
  "NEXT_PUBLIC_OKTA_CLIENT_ID",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "NEXT_PUBLIC_ENTRA_TENANT_ID",
  "NEXT_PUBLIC_ENTRA_CLIENT_ID",
];

/** Capture the current values so `restoreAuthEnv` can put them back exactly, including "unset". */
export function snapshotAuthEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const name of AUTH_ENV_NAMES) out[name] = process.env[name];
  return out;
}

/** Remove every auth variable so each case starts from a known-empty environment. */
export function clearAuthEnv(): void {
  for (const name of AUTH_ENV_NAMES) delete process.env[name];
}

/** Set the given variables for the current case. */
export function setAuthEnv(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
}

/** Put the environment back the way `snapshotAuthEnv` found it. */
export function restoreAuthEnv(snapshot: Record<string, string | undefined>): void {
  for (const name of AUTH_ENV_NAMES) {
    const value = snapshot[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

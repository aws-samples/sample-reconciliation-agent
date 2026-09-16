/**
 * Scoped `process.env` control for tests whose subject reads the environment at call time.
 *
 * Generalises the former `__tests__/lib/auth/testEnv.ts` (its `AUTH_ENV_NAMES` list is kept as a
 * preset) and replaces the module-scope `process.env.X = "..."` blocks the pipeline BFF tests opened
 * with, which set values for the file and never put them back.
 *
 * `scopedEnv` remembers the value of every name it is given at the moment it is created, so
 * `restore()` in an `afterAll` puts the environment back exactly, including "unset", and nothing
 * leaks into a sibling file in the same worker. `clear()` in a `beforeEach` starts every case from a
 * known-empty environment; `set()` applies a case's values (`undefined` unsets). Names first seen in
 * `set()` are tracked too, so they are restored as well.
 *
 * Two call shapes:
 *   const env = scopedEnv(AUTH_ENV_NAMES);                     // track; clear and set per case
 *   const env = scopedEnv({ AWS_REGION: "us-east-1", ... });   // track and set now, for the file
 *   const env = scopedEnv(["X"], { AWS_REGION: "us-east-1" }); // both
 * followed by `afterAll(() => env.restore())`.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */

import { APPS, CONSOLE_ADMIN_GROUP_ENV } from "@/lib/auth/apps";
import {
  CONSOLE_DEFAULT_MODEL_ID_ENV,
  CONSOLE_ORGANIZATION_LABEL_ENV,
  CONSOLE_SETTINGS_PREFIX_ENV,
} from "@/lib/console/types";

export type EnvValues = Record<string, string | undefined>;

/** Every environment variable the auth stack reads. Group names come from the registry so the list cannot drift. */
export const AUTH_ENV_NAMES: readonly string[] = [
  "ALLOW_ANONYMOUS_API",
  "RECON_ALLOW_ANONYMOUS_API",
  "PIPELINE_ALLOW_ANONYMOUS_API",
  "ANONYMOUS_GROUPS",
  "REQUIRE_ACCESS_GROUPS",
  ...APPS.flatMap((app) => [app.accessGroupEnv, app.adminGroupEnv]),
  ...APPS.flatMap((app) => (app.enabledEnv ? [app.enabledEnv] : [])),
  // The console layer: cleared too, so a developer's shell with a real prefix set never makes these
  // tests reach for Parameter Store.
  CONSOLE_ADMIN_GROUP_ENV,
  CONSOLE_SETTINGS_PREFIX_ENV,
  CONSOLE_ORGANIZATION_LABEL_ENV,
  CONSOLE_DEFAULT_MODEL_ID_ENV,
  "AUTH_GROUPS_CLAIM",
  "AUTH_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
  // Cognito is the DEFAULT provider, so these have to be cleared like the rest: a developer's shell
  // that happens to export a real pool id would otherwise leave `resolveApiAuth({})` resolving to a
  // working configuration in a test that meant to have none.
  "COGNITO_USER_POOL_ID",
  "COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_USER_POOL_ID",
  "NEXT_PUBLIC_COGNITO_CLIENT_ID",
  "NEXT_PUBLIC_COGNITO_HOSTED_UI",
  "NEXT_PUBLIC_COGNITO_REDIRECT_URI",
  "OKTA_ISSUER",
  "OKTA_CLIENT_ID",
  "NEXT_PUBLIC_OKTA_ISSUER",
  "NEXT_PUBLIC_OKTA_CLIENT_ID",
  "ENTRA_TENANT_ID",
  "ENTRA_CLIENT_ID",
  "NEXT_PUBLIC_ENTRA_TENANT_ID",
  "NEXT_PUBLIC_ENTRA_CLIENT_ID",
];

/** Capture the current values of `names`, including "unset". */
export function snapshotEnv(names: readonly string[]): EnvValues {
  const out: EnvValues = {};
  for (const name of names) out[name] = process.env[name];
  return out;
}

/** Remove every one of `names`. */
export function clearEnv(names: readonly string[]): void {
  for (const name of names) delete process.env[name];
}

/** Assign `values`; an `undefined` value unsets the variable. */
export function setEnv(values: EnvValues): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Put every variable in `snapshot` back the way `snapshotEnv` found it. */
export function restoreEnv(snapshot: EnvValues): void {
  setEnv(snapshot);
}

export interface ScopedEnv {
  /** The names tracked so far. */
  readonly names: readonly string[];
  /** The current values of the tracked names. */
  snapshot(): EnvValues;
  /** Unset every tracked name. */
  clear(): void;
  /** Assign values for the current case; names not yet tracked are tracked from here on. */
  set(values: EnvValues): void;
  /** Put every tracked name back to its value when the scope was created. */
  restore(): void;
}

export function scopedEnv(names: readonly string[], initial?: EnvValues): ScopedEnv;
export function scopedEnv(initial: EnvValues): ScopedEnv;
export function scopedEnv(namesOrInitial: readonly string[] | EnvValues, maybeInitial?: EnvValues): ScopedEnv {
  const initial = Array.isArray(namesOrInitial) ? maybeInitial : (namesOrInitial as EnvValues);
  const original = new Map<string, string | undefined>();
  const track = (name: string) => {
    if (!original.has(name)) original.set(name, process.env[name]);
  };
  for (const name of Array.isArray(namesOrInitial) ? namesOrInitial : []) track(name);
  for (const name of Object.keys(initial ?? {})) track(name);
  if (initial) setEnv(initial);

  return {
    get names() {
      return [...original.keys()];
    },
    snapshot: () => snapshotEnv([...original.keys()]),
    clear: () => clearEnv([...original.keys()]),
    set(values) {
      for (const name of Object.keys(values)) track(name);
      setEnv(values);
    },
    restore: () => setEnv(Object.fromEntries(original)),
  };
}

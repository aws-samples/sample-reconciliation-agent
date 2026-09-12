/**
 * Compatibility shim: the auth environment helpers live in `__tests__/helpers/env.ts`.
 *
 * Kept only because `__tests__/lib/api-auth.test.ts` (a recon test that predates the helpers
 * directory) imports these four names; new tests use `scopedEnv(AUTH_ENV_NAMES)` directly.
 */
import {
  AUTH_ENV_NAMES,
  clearEnv,
  restoreEnv,
  setEnv,
  snapshotEnv,
  type EnvValues,
} from "../../helpers/env";

export { AUTH_ENV_NAMES };
export const snapshotAuthEnv = (): EnvValues => snapshotEnv(AUTH_ENV_NAMES);
export const clearAuthEnv = (): void => clearEnv(AUTH_ENV_NAMES);
export const setAuthEnv = (values: Record<string, string>): void =>
  setEnv(values);
// Iterates the auth names, not the snapshot's keys, so a partial snapshot still clears the rest —
// the contract the original helper had.
export const restoreAuthEnv = (snapshot: EnvValues): void =>
  restoreEnv(
    Object.fromEntries(
      AUTH_ENV_NAMES.map((name) => [name, snapshot[name]]),
    ) as EnvValues,
  );

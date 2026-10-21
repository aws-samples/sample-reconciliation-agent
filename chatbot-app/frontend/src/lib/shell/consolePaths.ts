/**
 * Where the console's own screens live, as opposed to either application's page tree.
 *
 * `/console/*` is not an app: it has no entry in the `APPS` registry, no access group and no BFF
 * prefix of its own. The shell must therefore recognise it separately — the rail highlights its
 * Settings entry there, and the content column renders it without the per-app access panel. Kept out
 * of `lib/auth/apps.ts` so the registry stays a list of applications and nothing else.
 */

/** Page-tree prefix of the console's own screens. */
export const CONSOLE_PATH_PREFIX = "/console";

/** Where the rail's Settings entry points. The page redirects `/console` here as well. */
export const CONSOLE_SETTINGS_PATH = `${CONSOLE_PATH_PREFIX}/settings`;

/**
 * Whether a path belongs to the console's own screens.
 *
 * @param pathname current page path; `null`/`undefined` (router not ready) reads as "no".
 */
export function isConsolePath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === CONSOLE_PATH_PREFIX || pathname.startsWith(`${CONSOLE_PATH_PREFIX}/`);
}

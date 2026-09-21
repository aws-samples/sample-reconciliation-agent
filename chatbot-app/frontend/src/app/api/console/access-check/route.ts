import { requireConsoleAdmin } from "@/lib/console/admin";
import { errorResponse, jsonNoStore } from "@/lib/console/http";
import { effectiveEnv, isConsoleAdmin } from "@/lib/console/settings";
import { parseGroupList } from "@/lib/console/validation";
import { resolveAppAccess } from "@/lib/auth/apps";
import type { AccessCheckResult } from "@/lib/console/types";

// "What would a user in these groups see?" for the Settings screen. Runs the SAME functions the
// proxy and `/api/me` run, against the SAME overlaid environment, so the answer is a prediction of
// what the console will actually do and not a second implementation that can drift. Console admins
// only: the answer reveals which groups gate which app.
export const runtime = "nodejs";

/**
 * Resolve per-app access and console-admin status for a hypothetical set of groups.
 *
 * `?groups=a,b`: comma-separated, trimmed, de-duplicated; absent means "a user in no groups".
 *
 * @returns 200 with `AccessCheckResult`; 401/503 from token verification; 403 for a non-admin.
 */
export async function GET(req: Request) {
  const who = await requireConsoleAdmin(req);
  if ("error" in who) return who.error;
  try {
    const groups = parseGroupList(new URL(req.url).searchParams.get("groups"));
    const result: AccessCheckResult = {
      groups,
      apps: resolveAppAccess(groups, await effectiveEnv()),
      // Environment-only: the overlay never carries CONSOLE_ADMIN_GROUP, so the default env is right.
      consoleAdmin: isConsoleAdmin(groups),
    };
    return jsonNoStore(result);
  } catch (err) {
    return errorResponse(err);
  }
}

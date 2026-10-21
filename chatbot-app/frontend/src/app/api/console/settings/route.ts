import { requireConsoleAdmin } from "@/lib/console/admin";
import { errorResponse, jsonError, jsonNoStore, readJson } from "@/lib/console/http";
import { getConsoleSettings, updateConsoleSettings } from "@/lib/console/settings";

// Console-wide settings: the stored overlay on the per-app access groups, app enablement and the
// console defaults (see `lib/console/types.ts`). Console admins only, for GET as well as PUT: the
// body names every group that gates every app, which is a map of the deployment's authorization and
// not something every authenticated user should be able to read.
//
// GET answers on a deployment WITHOUT the stored layer too (`configured: false`, every field from
// env/default) so the Settings screen can render read-only with an explanation. PUT on such a
// deployment is a 409: the request is well-formed, but there is nowhere to put it.
export const runtime = "nodejs";

/**
 * Report every console setting with where its value came from.
 *
 * @returns 200 with `ConsoleSettings`; 401/503 from token verification; 403 for a non-admin; 500 when
 *   Parameter Store could not be read (an admin must see that, not a screen claiming env defaults).
 */
export async function GET(req: Request) {
  const who = await requireConsoleAdmin(req);
  if ("error" in who) return who.error;
  try {
    return jsonNoStore(await getConsoleSettings());
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Apply a `ConsoleSettingsUpdate` and answer with the refreshed settings.
 *
 * @returns 200 with `ConsoleSettings` as now in effect; 400 naming the bad field; 409 when the layer
 *   is not configured; 401/403/503 as for GET.
 */
export async function PUT(req: Request) {
  const who = await requireConsoleAdmin(req);
  if ("error" in who) return who.error;
  const parsed = await readJson(req);
  if (!parsed.ok) return jsonError(400, "body must be JSON");
  try {
    return jsonNoStore(await updateConsoleSettings(parsed.body, who.actor));
  } catch (err) {
    return errorResponse(err);
  }
}

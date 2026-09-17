import { authorizeRequest } from "@/lib/api-auth";
import { errorResponse, jsonError, jsonNoStore, readJson } from "@/lib/console/http";
import { getPreferences, isConsoleConfigured, putPreferences } from "@/lib/console/settings";

// One user's console preferences (default app, rail state, theme). Any authenticated user, and only
// their own row: the subject comes from the verified token, never from the body or the query, so
// there is no way to read or write someone else's.
//
// When the stored layer is not configured, GET answers `{}` and PUT answers 409, and the shell keeps
// using the browser's localStorage as it did before the layer existed.
export const runtime = "nodejs";

/**
 * The caller's stored preferences.
 *
 * @returns 200 with `UserPreferences` (`{}` when nothing is stored or the layer is off); 401/503 from
 *   token verification; 500 when Parameter Store could not be read.
 */
export async function GET(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.message);
  try {
    return jsonNoStore(await getPreferences(auth.subject));
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Replace the caller's stored preferences.
 *
 * @returns 200 with the preferences as stored; 400 naming the bad field; 409 when the layer is not
 *   configured; 401/503 from token verification.
 */
export async function PUT(req: Request) {
  const auth = await authorizeRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.message);
  // Checked before the body is read so the UI gets the "use the browser" signal even for a body it
  // would otherwise have been told to fix.
  if (!isConsoleConfigured()) {
    return jsonError(409, "console preferences are not stored on this deployment; the browser keeps them");
  }
  const parsed = await readJson(req);
  if (!parsed.ok) return jsonError(400, "body must be JSON");
  try {
    return jsonNoStore(await putPreferences(auth.subject, parsed.body));
  } catch (err) {
    return errorResponse(err);
  }
}

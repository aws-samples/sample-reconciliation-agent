"use client";

import { useEffect, useState } from "react";

import { APPS, type AppAccess, type AppId, type Viewer } from "@/lib/auth/apps";
import { authHeaders } from "@/lib/pipeline-auth";

// The console viewer: who is signed in and which applications they may open, as `/api/me` reports it.
//
// This is the shell's ONE identity read. The app rail, the landing page and the no-access panel all
// consume it, and each app keeps its own `/api/<app>/me` hook for its own admin gating — the shell does
// not replace those, it sits beside them. Every field here is advisory for rendering only: the proxy
// already 403s an API call the viewer may not make, so a client that lies to itself about `apps` gets
// an empty page, not data.
//
// The Authorization header comes from the deal-pipeline token helper rather than a third copy of the
// Okta/Entra token-reading code. Both existing helpers are byte-identical apart from their log prefix;
// picking one keeps the shell on the same ID token the BFF verifies everywhere else.

/**
 * Page trees that render without the shell.
 *
 * The auth handshake pages run BEFORE there is a session to describe, `/health` is a probe with no
 * page at all, and `/embed` is meant for iframes where a second navigation frame would be noise. A path
 * is hidden when it equals an entry or lives under it (`/login/callback`).
 */
export const SHELL_HIDDEN_PATHS: readonly string[] = ["/login", "/oauth-complete", "/health", "/embed"];

/**
 * Whether the shell (rail and access gating) stays out of the way on this path.
 *
 * @param pathname current page path; `null`/`undefined` (router not ready) is treated as visible so a
 *   momentary unknown never flashes the rail off.
 */
export function isShellHidden(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return SHELL_HIDDEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const DENIED: AppAccess = { access: false, admin: false };

/**
 * Shape a `/api/me` body into a `Viewer` field by field rather than trusting it whole.
 *
 * A route that answers with a partial body (an older deployment, a proxy that rewrote it) must still yield
 * something the rail can render — and the safe reading of a missing app entry is "no access", never "open".
 */
export function normalizeViewer(raw: unknown): Viewer {
  const body = (raw ?? {}) as Partial<Record<keyof Viewer, unknown>>;
  const rawApps = (body.apps ?? {}) as Partial<Record<AppId, Partial<AppAccess>>>;
  const apps = {} as Record<AppId, AppAccess>;
  for (const app of APPS) {
    const entry = rawApps[app.id];
    const admin = entry?.admin === true;
    // Admins implicitly have access (see apps.ts); honour that even if the route forgot to say so.
    apps[app.id] = entry ? { access: entry.access === true || admin, admin } : DENIED;
  }
  return {
    subject: typeof body.subject === "string" ? body.subject : "",
    groups: Array.isArray(body.groups) ? body.groups.filter((g): g is string => typeof g === "string") : [],
    // Informational only; passed through so a provider added later does not break the shell.
    mode: (typeof body.mode === "string" ? body.mode : "anonymous") as Viewer["mode"],
    apps,
  };
}

/** Pull the `{ error }` the BFF puts in failure bodies, or the status text when there is none. */
async function readFailure(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON (a load balancer page, an empty 502). The status alone is still worth showing.
  }
  return res.statusText || "no detail";
}

/**
 * Fetch the console viewer once.
 *
 * @returns the normalized viewer.
 * @throws when `/api/me` answers anything but 2xx, with the status and the server's reason in the
 *   message — that string is what the shell's banner shows, so a 503 "AUTH_PROVIDER is unset" reads as
 *   itself rather than as a blank rail.
 */
export async function fetchViewer(): Promise<Viewer> {
  const headers = await authHeaders();
  const res = await fetch("/api/me", { headers, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`GET /api/me failed (${res.status}): ${await readFailure(res)}`);
  }
  return normalizeViewer(await res.json());
}

export interface ViewerState {
  /** The viewer once known; `null` while loading or after a failure. */
  viewer: Viewer | null;
  loading: boolean;
  /** Why there is no viewer, for the banner. `null` while loading or on success. */
  error: string | null;
}

const LOADING: ViewerState = { viewer: null, loading: true, error: null };

// Module-scope cache, same pattern as `useReconSubject`: a PROMISE, so concurrent mounts (the rail and
// the landing page mount in the same tick) share one in-flight request instead of racing two. A settled
// value is kept alongside so a component mounted after the answer arrived (client-side navigation to `/`)
// renders it on its first paint instead of flashing a skeleton.
let shared: Promise<Viewer> | null = null;
let settled: Viewer | null = null;

/**
 * The shared viewer promise, started on first call.
 *
 * A failure clears the cache so the next mount retries — a transient 502 during a deploy must not pin
 * the banner for the whole session, and nothing else ever invalidates it.
 */
export function loadViewer(): Promise<Viewer> {
  if (!shared) {
    shared = fetchViewer().then(
      (viewer) => {
        settled = viewer;
        return viewer;
      },
      (err: unknown) => {
        shared = null;
        throw err;
      },
    );
  }
  return shared;
}

/** Forget the cached viewer. For tests, and for a future "signed in as someone else" transition. */
export function resetViewerCache(): void {
  shared = null;
  settled = null;
}

/**
 * The console viewer, for rendering decisions.
 *
 * @returns `loading: true` until `/api/me` answers (or immediately the cached viewer when it already
 *   has), then either the viewer or the error string. Never throws into the tree.
 */
export function useViewer(): ViewerState {
  const [state, setState] = useState<ViewerState>(() =>
    settled ? { viewer: settled, loading: false, error: null } : LOADING,
  );

  useEffect(() => {
    let live = true;
    loadViewer().then(
      (viewer) => {
        // Functional update with a bail-out: a component that initialised from the settled cache already
        // holds this viewer, and handing React the same state object back schedules nothing.
        if (live) {
          setState((prev) =>
            prev.viewer === viewer ? prev : { viewer, loading: false, error: null },
          );
        }
      },
      (err: unknown) => {
        if (live) {
          setState({
            viewer: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
    return () => {
      // Setting state on an unmounted component is a warning at best; on a page the user has already
      // left it is pure noise.
      live = false;
    };
  }, []);

  return state;
}

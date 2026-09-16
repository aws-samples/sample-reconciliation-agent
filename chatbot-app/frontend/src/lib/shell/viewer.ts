"use client";

import { useEffect, useSyncExternalStore } from "react";

import { authHeaders } from "@/lib/auth/client-token";
import { APPS, type AppAccess, type AppId, type Viewer } from "@/lib/auth/apps";
import type { UserPreferences, ViewerConsoleFields } from "@/lib/console/types";
import { reauthenticate } from "@/lib/reauth";
import { normalizePreferences } from "@/lib/shell/preferences";

// The console viewer: who is signed in and which applications they may open, as `/api/me` reports it.
//
// This is the console's ONE identity read. The app rail, the landing page and the no-access panel
// consume it directly, and each app projects it through `useAppSubject(appId)` (`hooks/useAppSubject.ts`)
// for its own admin gating and column-preference keys. Every field here is advisory for rendering only: the proxy
// already 403s an API call the viewer may not make, so a client that lies to itself about `apps` gets
// an empty page, not data.
//
// The Authorization header comes from the console-level token helper in `lib/auth/`, the same one both
// apps' fetch wrappers use, so the shell verifies against the same ID token as everything else and
// depends on neither application's module.

/**
 * Page trees that render without the shell.
 *
 * The auth handshake pages run BEFORE there is a session to describe, `/health` is a probe with no
 * page at all, and `/embed` is meant for iframes where a second navigation frame would be noise. A path
 * is hidden when it equals an entry or lives under it (`/login/callback`).
 *
 * One handshake path per provider, because each provider dictates its own: `/login/callback` is the
 * Okta redirect URI, `/callback` is the Cognito app client's, and Entra returns to the origin.
 */
export const SHELL_HIDDEN_PATHS: readonly string[] = [
  "/login",
  "/callback",
  "/oauth-complete",
  "/health",
  "/embed",
];

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
 * The viewer as the shell sees it: the registry's `Viewer` plus the console-level fields `/api/me`
 * added with the configuration layer (`ViewerConsoleFields`).
 */
export type ConsoleViewer = Viewer & ViewerConsoleFields;

/**
 * What the console fields read as when `/api/me` did not send them (an older image).
 *
 * Not an admin, not configured, no label: the Settings screens then render read-only and the
 * preferences fall back to the browser, which is exactly what a deployment without the layer does.
 */
export const DEFAULT_CONSOLE_FIELDS: ViewerConsoleFields["console"] = {
  admin: false,
  configured: false,
  organizationLabel: "",
};

/** The `console` block of a `/api/me` body, each flag read strictly so a stray truthy value grants nothing. */
function normalizeConsole(raw: unknown): ViewerConsoleFields["console"] {
  const body = (raw ?? {}) as Record<string, unknown>;
  return {
    admin: body.admin === true,
    configured: body.configured === true,
    organizationLabel: typeof body.organizationLabel === "string" ? body.organizationLabel.trim() : "",
  };
}

/**
 * Shape a `/api/me` body into a `ConsoleViewer` field by field rather than trusting it whole.
 *
 * A route that answers with a partial body (an older deployment, a proxy that rewrote it) must still yield
 * something the rail can render — and the safe reading of a missing app entry is "no access", never "open".
 * The console fields default the same way: absent means read-only Settings and browser-only preferences.
 */
export function normalizeViewer(raw: unknown): ConsoleViewer {
  const body = (raw ?? {}) as Partial<Record<keyof ConsoleViewer, unknown>>;
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
    console: normalizeConsole(body.console),
    preferences: normalizePreferences(body.preferences),
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
export async function fetchViewer(): Promise<ConsoleViewer> {
  const headers = await authHeaders();
  const res = await fetch("/api/me", { headers, cache: "no-store" });
  if (res.status === 401) {
    // The same backstop the apps' fetch wrappers have. `/api/me` is the only request on `/`, so when a
    // session dies while the user is there (an Entra refresh token past its lifetime: the silent token
    // read fails, the header is missing, the proxy says 401) nothing else would ever start the redirect
    // and the landing page would stay on its error card. Not awaited: the redirect resolves as the page
    // unloads, and the error below must still reach the banner if the loop guard refuses.
    void reauthenticate("unauthorized").catch((error: unknown) =>
      console.error("[Shell] re-authentication failed:", error),
    );
  }
  if (!res.ok) {
    throw new Error(`GET /api/me failed (${res.status}): ${await readFailure(res)}`);
  }
  return normalizeViewer(await res.json());
}

export interface ViewerState {
  /** The viewer once known; `null` while loading or after a failure. */
  viewer: ConsoleViewer | null;
  loading: boolean;
  /** Why there is no viewer, for the banner. `null` while loading or on success. */
  error: string | null;
}

const LOADING: ViewerState = { viewer: null, loading: true, error: null };

// A module-scope STORE rather than a per-hook snapshot. The shell frame mounts once in the root layout
// and stays mounted across every client-side navigation, so it must see the result of a request that a
// later mount (the landing page after a failure) or the banner's Retry started — a snapshot copied into
// each hook at mount time would leave the frame pinned on the first answer for the whole session. One
// in-flight promise is shared so concurrent mounts (the rail and the landing page mount in the same tick)
// ask `/api/me` once; a settled value is served synchronously so a component mounted after the answer
// (client-side navigation to `/`) renders it on its first paint instead of flashing a skeleton.
let snapshot: ViewerState = LOADING;
let inflight: Promise<ViewerState> | null = null;
/** Identifies the newest request; an older one that settles after a reset or reload must not publish. */
let current: object | null = null;
const listeners = new Set<() => void>();

function publish(next: ViewerState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ViewerState {
  return snapshot;
}

/** The server has no session to describe; every SSR pass reads as loading. */
function getServerSnapshot(): ViewerState {
  return LOADING;
}

/** Start one `/api/me` round trip and publish its outcome to every subscriber. */
function start(): Promise<ViewerState> {
  const token = {};
  current = token;
  publish(LOADING);
  const request = fetchViewer()
    .then(
      (viewer): ViewerState => ({ viewer, loading: false, error: null }),
      (err: unknown): ViewerState => ({
        viewer: null,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    .then((state) => {
      if (current === token) {
        inflight = null;
        publish(state);
      }
      return state;
    });
  inflight = request;
  return request;
}

/**
 * Make sure the viewer is being (or has been) loaded.
 *
 * Idempotent while a request is in flight or a viewer is known. After a FAILURE it starts a fresh
 * request, so a component that mounts later retries — a transient 502 during a deploy must not pin
 * the banner for the whole session — and, because every subscriber reads the same store, the frame
 * that showed the failure recovers along with it.
 *
 * @returns the settled state; never rejects, the failure is in `error`.
 */
export function loadViewer(): Promise<ViewerState> {
  if (inflight) return inflight;
  if (snapshot.viewer) return Promise.resolve(snapshot);
  return start();
}

/**
 * Discard what is known and ask `/api/me` again.
 *
 * For the banner's Retry, and for a future "signed in as someone else" transition. Subscribers see
 * `loading` while the request runs so nothing renders the stale identity in between.
 *
 * @returns the settled state; never rejects.
 */
export function reloadViewer(): Promise<ViewerState> {
  if (inflight) return inflight;
  return start();
}

/**
 * Replace the known viewer's preferences without asking `/api/me` again.
 *
 * The Preferences screen and the rail's collapse button both change a preference the rest of the shell
 * reacts to (the theme, the rail width, the landing default), and the store is the one channel they all
 * read. A new viewer OBJECT is published on purpose: the shell applies a viewer's preferences once per
 * object, so this is what makes a change on the Preferences screen reach the rail without a reload.
 * A no-op while no viewer is known — there is nothing to attach the preferences to, and the next
 * `/api/me` answer carries the stored row anyway.
 *
 * @param preferences the complete new row, as sent to (or confirmed by) `PUT /api/console/preferences`.
 */
export function updateViewerPreferences(preferences: UserPreferences): void {
  if (!snapshot.viewer) return;
  publish({ ...snapshot, viewer: { ...snapshot.viewer, preferences: normalizePreferences(preferences) } });
}

/** Forget the cached viewer. For tests. Subscribers are told so none keeps rendering a stale answer. */
export function resetViewerCache(): void {
  inflight = null;
  current = null;
  publish(LOADING);
}

/**
 * The console viewer as the store currently knows it, WITHOUT starting or retrying the request.
 *
 * For components that live inside the shell's gated content (an app's nav, a table keying its column
 * layout on the subject): the frame that mounted them is the one initiator, and after a failure the
 * banner's Retry is the one retrier. If these components called `useViewer()` instead, a failed
 * `/api/me` would loop — the frame swaps the content for its skeleton while loading, the retry started by
 * a remounting child settles as the same failure, the children mount again and start another.
 *
 * @returns the same state `useViewer()` returns, read from the same store.
 */
export function useViewerSnapshot(): ViewerState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * The console viewer, for rendering decisions.
 *
 * Mounting this hook is what starts the request (and, after a failure, retries it). Use it from the
 * shell frame and the pages that render without the frame; inside the frame's gated content use
 * `useViewerSnapshot()` or `useAppSubject()`, which only read.
 *
 * @returns `loading: true` until `/api/me` answers (or immediately the cached viewer when it already
 *   has), then either the viewer or the error string. Never throws into the tree, and updates in place
 *   when any other mount or the banner's Retry reloads the viewer.
 */
export function useViewer(): ViewerState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    // Mounting is what starts (or, after a failure, retries) the request; rendering must stay pure.
    void loadViewer();
  }, []);
  return state;
}

"use client";

import { useEffect, useState } from "react";
import type { AppAccess, AppId, Viewer } from "@/lib/auth/apps";
import { authedFetch } from "@/lib/auth/authed-fetch";

// The signed-in viewer, as the server sees them, for ONE app. Two consumers: `DataTable` keys stored
// column layouts on the subject, and the app's nav hides admin-only links from anyone outside that
// app's admin group.
//
// Reads the shell's `/api/me` — one identity route for every app — and derives `isAdmin` from the
// per-app access block it carries (`apps[appId].admin`), so the answer agrees with the rail's admin
// chip and with the proxy, all of which read the same registry (`lib/auth/apps.ts`).
//
// Cached in module scope, per app, so mounting five tables costs one request. The cache holds a
// PROMISE rather than a result, which is what makes concurrent mounts share one in-flight fetch
// instead of racing three of their own. Nothing invalidates it: identity does not change without a
// page load, and a token that expires mid-session sends the whole app through the re-auth redirect in
// `authedFetch`.
//
// Every field here is advisory for rendering only. `isAdmin` decides what a tab shows; it decides
// nothing about what a route will do, because each admin-gated route re-checks the group against the
// presented token.

export interface AppViewer {
  /** OIDC subject. Empty string when unauthenticated or unresolved — never a placeholder id. */
  subject: string;
  groups: string[];
  isAdmin: boolean;
}

const UNKNOWN: AppViewer = { subject: "", groups: [], isAdmin: false };

const cached = new Map<AppId, Promise<AppViewer>>();

/** The parts of the `/api/me` body this hook reads. Every field is checked before it is trusted. */
type MeBody = Partial<Pick<Viewer, "subject" | "groups">> & {
  apps?: Partial<Record<AppId, Partial<AppAccess> | undefined>>;
};

/**
 * Fetch the viewer once per page load and app, shared across all callers.
 *
 * @param appId the app whose admin group decides `isAdmin`.
 * @returns the viewer, or `UNKNOWN` on any failure — an unreadable identity must degrade to default
 *   column layouts and a hidden Config tab, not to a thrown error inside an unrelated panel.
 */
function fetchViewer(appId: AppId): Promise<AppViewer> {
  let pending = cached.get(appId);
  if (!pending) {
    pending = authedFetch("/api/me", {}, "AppSubject")
      .then(async (res) => {
        if (!res.ok) return UNKNOWN;
        const body = (await res.json()) as MeBody;
        // Validated field by field rather than trusted whole: a route that answers with a partial body
        // must still yield a viewer the table and the nav can render, and nothing but the literal
        // `true` under THIS app's block may make anyone an admin — not a truthy string, and not
        // another app's flag.
        return {
          subject: typeof body.subject === "string" ? body.subject : "",
          groups: Array.isArray(body.groups) ? body.groups : [],
          isAdmin: body.apps?.[appId]?.admin === true,
        };
      })
      .catch(() => UNKNOWN);
    cached.set(appId, pending);
  }
  return pending;
}

/**
 * The signed-in viewer, for rendering decisions in one app.
 *
 * @param appId the app whose admin group decides `isAdmin`.
 * @returns `UNKNOWN` on the first render and the resolved viewer once `/api/me` answers. Callers must
 *   treat the empty subject as "not yet known" rather than as an identity — writing a stored
 *   preference under it would give every viewer on a shared browser the same key.
 */
export function useAppSubject(appId: AppId): AppViewer {
  const [viewer, setViewer] = useState<AppViewer>(UNKNOWN);

  useEffect(() => {
    let live = true;
    void fetchViewer(appId).then((v) => {
      // Guard the unmount case: setting state on a gone component is a warning at best and, in a tab the
      // viewer has already navigated away from, pure noise.
      if (live) setViewer(v);
    });
    return () => {
      live = false;
    };
  }, [appId]);

  return viewer;
}

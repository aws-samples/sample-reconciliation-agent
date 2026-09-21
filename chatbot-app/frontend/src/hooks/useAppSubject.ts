"use client";

import { useMemo } from "react";

import type { AppId } from "@/lib/auth/apps";
import { useViewerSnapshot } from "@/lib/shell/viewer";

// The signed-in viewer, as the server sees them, for ONE app. Two consumers: `DataTable` keys stored
// column layouts on the subject, and the app's nav hides admin-only links from anyone outside that
// app's admin group.
//
// A projection of the shell's viewer store (`lib/shell/viewer.ts`), not a second request and not a
// retry: this hook only READS the store (`useViewerSnapshot`). The shell frame that mounted the page is
// what asks `/api/me`, once per page load however many components mount — the rail, the landing page,
// five tables — and `isAdmin` is that body's per-app access block (`apps[appId].admin`), so the answer
// agrees with the rail's admin chip and with the proxy, all of which read the same registry
// (`lib/auth/apps.ts`). Before this each app fetched its own `/api/<app>/me` beside the shell's
// `/api/me`: two identity round trips per page for one identity.
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

/**
 * The signed-in viewer, for rendering decisions in one app.
 *
 * @param appId the app whose admin group decides `isAdmin`.
 * @returns `UNKNOWN` while the store is loading and after a failure — an unreadable identity must
 *   degrade to default column layouts and a hidden Config tab, not to a thrown error inside an
 *   unrelated panel — and the viewer once `/api/me` has answered. Callers must treat the empty
 *   subject as "not yet known" rather than as an identity — writing a stored preference under it
 *   would give every viewer on a shared browser the same key.
 */
export function useAppSubject(appId: AppId): AppViewer {
  const { viewer } = useViewerSnapshot();
  // Memoised on the store's viewer object so a consumer that lists the result in a dependency array
  // sees one value per identity, as it did when this hook held its own state.
  return useMemo(
    () =>
      viewer
        ? {
            subject: viewer.subject,
            groups: viewer.groups,
            // Nothing but the literal `true` under THIS app's block makes anyone an admin — not a
            // truthy string, and not another app's flag. `normalizeViewer` already reads it strictly.
            isAdmin: viewer.apps[appId]?.admin === true,
          }
        : UNKNOWN,
    [viewer, appId],
  );
}

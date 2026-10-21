"use client";

import { useAppSubject, type AppViewer } from "@/hooks/useAppSubject";

// The signed-in viewer, as the server sees them, for the recon app. Two consumers: `DataTable` keys
// stored column layouts on the subject, and the Config tab hides itself from anyone who is not in the
// admin group.
//
// A named binding of the shared `useAppSubject("recon")`, which projects the shell's one `/api/me`
// read (`lib/shell/viewer.ts`) rather than fetching a recon-specific route: one identity request per
// page for the rail, the nav and every table. Kept under this name so the recon pages, and the tests
// that mock `@/hooks/useReconSubject`, need not change.
//
// Every field here is advisory for rendering only. `isAdmin` decides what a tab shows; it decides nothing
// about what a route will do, because each config route re-checks the group against the presented token.

export type ReconViewer = AppViewer;

/**
 * The signed-in viewer, for rendering decisions.
 *
 * @returns the unknown viewer (empty subject, not admin) until `/api/me` answers, then the resolved
 *   viewer. Callers must treat the empty subject as "not yet known" rather than as an identity —
 *   writing a stored preference under it would give every viewer on a shared browser the same key.
 */
export const useReconSubject = (): ReconViewer => useAppSubject("recon");

"use client";

import { useEffect, useState } from "react";
import { getMe } from "@/lib/pipelineApi";

// The signed-in viewer, as the server sees them. Two consumers: `DataTable` keys stored column layouts
// on the subject, and the Config tab hides itself from anyone who is not in the admin group.
//
// Cached in module scope, so mounting five tables costs one request. The cache holds a PROMISE rather
// than a result, which is what makes concurrent mounts share one in-flight fetch instead of racing three
// of their own. Nothing invalidates it: identity does not change without a page load, and a token that
// expires mid-session sends the whole app through the re-auth redirect in `pipelineFetch`.
//
// Every field here is advisory for rendering only. `isAdmin` decides what a tab shows; it decides nothing
// about what a route will do, because each admin-gated route re-checks the group against the presented
// token.

export interface PipelineViewer {
  /** OIDC subject. Empty string when unauthenticated or unresolved — never a placeholder id. */
  subject: string;
  groups: string[];
  isAdmin: boolean;
}

const UNKNOWN: PipelineViewer = { subject: "", groups: [], isAdmin: false };

let cached: Promise<PipelineViewer> | null = null;

/**
 * Fetch the viewer once per page load, shared across all callers.
 *
 * @returns the viewer, or `UNKNOWN` on any failure — an unreadable identity must degrade to default
 *   column layouts and a hidden Config tab, not to a thrown error inside an unrelated panel.
 */
function fetchViewer(): Promise<PipelineViewer> {
  if (!cached) {
    cached = getMe()
      .then((body) => ({
        // Validated field by field rather than trusted whole: a route that answers with a partial
        // body must still yield a viewer the table and the nav can render.
        subject: typeof body.subject === "string" ? body.subject : "",
        groups: Array.isArray(body.groups) ? body.groups : [],
        isAdmin: body.isAdmin === true,
      }))
      .catch(() => UNKNOWN);
  }
  return cached;
}

/**
 * The signed-in viewer, for rendering decisions.
 *
 * @returns `UNKNOWN` on the first render and the resolved viewer once `/api/pipeline/me` answers.
 *   Callers must treat the empty subject as "not yet known" rather than as an identity — writing a
 *   stored preference under it would give every viewer on a shared browser the same key.
 */
export function usePipelineSubject(): PipelineViewer {
  const [viewer, setViewer] = useState<PipelineViewer>(UNKNOWN);

  useEffect(() => {
    let live = true;
    void fetchViewer().then((v) => {
      // Guard the unmount case: setting state on a gone component is a warning at best and, in a tab the
      // viewer has already navigated away from, pure noise.
      if (live) setViewer(v);
    });
    return () => {
      live = false;
    };
  }, []);

  return viewer;
}

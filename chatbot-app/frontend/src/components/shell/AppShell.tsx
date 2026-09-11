"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AlertTriangle, Lock, RefreshCw } from "lucide-react";

import { AppRail } from "@/components/shell/AppRail";
import { appForPagePath, type AppDefinition } from "@/lib/auth/apps";
import { isShellHidden, reloadViewer, useViewer } from "@/lib/shell/viewer";

// The console frame: rail on the left, the current application on the right.
//
// Mounted once in the root layout, INSIDE the auth wrapper, so by the time it renders there is a session
// to describe. It gates pages on the viewer's per-app access — the proxy already 403s the API calls, but
// a page whose every panel says "failed to load" is a worse answer than one panel that says why — and it
// stays out of the way on the auth handshake pages, which have no session to ask about yet.

/** DOM id of the content column, so the skip link has somewhere to land. */
export const SHELL_CONTENT_ID = "shell-content";

/**
 * Neutral placeholder for the content column while the viewer loads on an app path.
 *
 * Holding the page until access is known is what makes the no-access panel a replacement rather than an
 * overlay: mounting the app first would fire its fetches, collect a burst of 403s, and flash their error
 * placeholders for the length of one `/api/me` round trip.
 *
 * A `<main>`: the app layout that would normally provide the landmark is not mounted while this shows.
 */
function ContentSkeleton() {
  return (
    <main className="min-h-screen bg-[var(--shell-bg)] p-8" data-testid="shell-content-skeleton" aria-busy="true">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
        <div className="h-9 w-64 animate-pulse rounded-md bg-[var(--shell-panel)]" />
        <div className="h-4 w-96 animate-pulse rounded bg-[var(--shell-panel)]" />
        <div className="mt-6 h-64 animate-pulse rounded-md bg-[var(--shell-panel)]" />
      </div>
    </main>
  );
}

/** Shown INSTEAD of the app when the viewer may not open it. Its own `<main>`, since the app's is not mounted. */
function NoAccessPanel({ app }: { app: AppDefinition }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--shell-bg)] p-8 text-[var(--shell-ink)]">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-[var(--shell-line)] bg-[var(--shell-panel)] p-8 text-center">
        <Lock className="h-6 w-6 text-[var(--shell-ink-dim)]" aria-hidden="true" />
        <h1 className="text-heading font-semibold">No access to {app.label}</h1>
        {/* The live region is the explanation only: a link inside a status region is announced as text. */}
        <p role="status" className="text-label text-[var(--shell-ink-dim)]">
          Your account is not in the group that grants access to this application. Ask an administrator to
          add you, then sign in again.
        </p>
        <Link
          href="/"
          className="mt-2 rounded-md border border-[var(--shell-line)] px-4 py-2 text-label hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)]"
        >
          Back to the console
        </Link>
      </div>
    </main>
  );
}

/**
 * Slim banner when `/api/me` itself failed.
 *
 * The page still renders underneath: if the failure is a missing `/api/me` route (an older image) or a
 * transient 502, the apps may well work, and the operator debugging a 503 "AUTH_PROVIDER is unset" needs
 * to read that string somewhere other than the network tab. Retry re-asks without a reload, which is also
 * what un-pins the rail's "Applications unavailable" once the transient has passed.
 *
 * `--shell-danger-panel` is opaque on purpose: this is the one shell surface that sits directly on `body`,
 * which is white in the light colour scheme, and the translucent danger tint over white left the
 * near-white shell ink unreadable.
 */
function ViewerErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--shell-danger)] bg-[var(--shell-danger-panel)] px-4 py-2 text-label text-[var(--shell-ink)]">
      <AlertTriangle className="h-4 w-4 shrink-0 text-[var(--shell-danger)]" aria-hidden="true" />
      {/* The alert is the sentence, not the whole bar: a live region should not contain the button. */}
      <span role="alert" className="min-w-0 flex-1">
        Could not load your console profile — navigation may be incomplete. {message}
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--shell-line)] px-2.5 py-1 text-caption hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </button>
    </div>
  );
}

/** The frame proper. Split from `AppShell` so hidden paths never start the `/api/me` request. */
function ShellFrame({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { viewer, loading, error } = useViewer();
  const currentApp = appForPagePath(pathname);
  const denied = Boolean(viewer && currentApp && !viewer.apps[currentApp.id]?.access);

  let body: ReactNode;
  if (loading && currentApp) {
    body = <ContentSkeleton />;
  } else if (denied && currentApp) {
    body = <NoAccessPanel app={currentApp} />;
  } else {
    body = (
      <>
        {error && <ViewerErrorBanner message={error} onRetry={() => void reloadViewer()} />}
        {children}
      </>
    );
  }

  return (
    <div className="flex min-h-screen">
      {/* First tab stop on every page: the rail is four or five stops that keyboard users would otherwise
          cross each time. Hidden until focused; `fixed` so it overlays rather than joining the flex row. */}
      <a
        href={`#${SHELL_CONTENT_ID}`}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-[var(--shell-accent)] focus:px-3 focus:py-2 focus:text-label focus:text-[var(--shell-bg)] focus:outline-none"
      >
        Skip to content
      </a>
      <AppRail viewer={viewer} loading={loading} currentApp={currentApp} />
      {/* `min-w-0` lets wide tables inside the apps shrink instead of pushing the rail off-screen; the
          apps' own sticky headers keep working because nothing here scrolls but the document. */}
      {/* Plain div, not <main>: each app layout renders its own <main>, and a page must have exactly one
          landmark. The shell's own views (skeleton, no-access panel, landing) each bring their own.
          `tabIndex={-1}` lets the skip link move focus here without adding a tab stop. */}
      <div id={SHELL_CONTENT_ID} tabIndex={-1} className="min-w-0 flex-1 outline-none">
        {body}
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  if (isShellHidden(pathname)) return <>{children}</>;
  return <ShellFrame pathname={pathname}>{children}</ShellFrame>;
}

export default AppShell;

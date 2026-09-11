"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Lock, LogIn } from "lucide-react";

import { APP_ICONS } from "@/components/shell/AppRail";
import { APPS, type AppDefinition } from "@/lib/auth/apps";
import { reauthenticate } from "@/lib/reauth";
import { useSignOut } from "@/lib/shell/signOut";
import { useViewer } from "@/lib/shell/viewer";

// The console landing. Used to be a hard redirect to the recon dashboard; with two applications behind
// group-based access it has to ask first. One accessible app still behaves like the old redirect, so a
// deployment that runs only the reconciliation app sees no change.
//
// Every view here is a `<main>`: this page mounts under the shell's content column, not under an app
// layout, so nothing else provides the landmark.

/** Centered placeholder while the viewer loads (and while a single-app redirect is in flight). */
function LandingSkeleton() {
  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[var(--shell-bg)] p-8"
      data-testid="landing-skeleton"
      aria-busy="true"
    >
      <div className="flex w-full max-w-3xl flex-col gap-4">
        <div className="h-8 w-72 animate-pulse rounded-md bg-[var(--shell-panel)]" />
        <div className="h-4 w-96 animate-pulse rounded bg-[var(--shell-panel)]" />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="h-40 animate-pulse rounded-lg bg-[var(--shell-panel)]" />
          <div className="h-40 animate-pulse rounded-lg bg-[var(--shell-panel)]" />
        </div>
      </div>
    </main>
  );
}

/** One card per application the viewer may open. */
function AppCard({ app }: { app: AppDefinition }) {
  const Icon = APP_ICONS[app.id];
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-[var(--shell-line)] bg-[var(--shell-panel)] p-6">
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--shell-accent-soft)] text-[var(--shell-accent)]">
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <h2 className="text-title font-semibold">{app.label}</h2>
      <p className="flex-1 text-label text-[var(--shell-ink-dim)]">{app.description}</p>
      <Link
        href={app.href}
        aria-label={`Open ${app.label}`}
        className="inline-flex w-fit items-center gap-2 rounded-md border border-[var(--shell-line)] px-3 py-1.5 text-label hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]"
      >
        Open
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </article>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--shell-bg)] p-8 text-[var(--shell-ink)]">
      <div className="w-full max-w-3xl">{children}</div>
    </main>
  );
}

const ACTION_CLASS =
  "inline-flex items-center gap-2 rounded-md border border-[var(--shell-line)] px-4 py-2 text-label hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]";

/**
 * The ways out of a card the viewer cannot proceed from.
 *
 * Sign out is hidden in anonymous mode: with no identity provider there is no session to end, and the
 * provider SDKs reject rather than redirect. "Sign in again" is offered on the error card because the
 * failure may be an expired session that the automatic redirect declined to retry (its loop guard), and a
 * user-initiated attempt bypasses that guard.
 */
function CardActions({ anonymous, signInAgain }: { anonymous: boolean; signInAgain?: boolean }) {
  const { signOut, error: signOutError } = useSignOut();
  const signIn = () => {
    // The redirect resolves as the page unloads; a rejection (no provider configured) is logged rather than
    // left as an unhandled promise, and `reauthenticate` itself already explains that case on the console.
    void reauthenticate("user").catch((err: unknown) => console.error("[Shell] sign in failed:", err));
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {signInAgain && !anonymous && (
          <button type="button" onClick={signIn} className={ACTION_CLASS}>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            Sign in again
          </button>
        )}
        {!anonymous && (
          <button type="button" onClick={signOut} className={ACTION_CLASS}>
            Sign out
          </button>
        )}
      </div>
      {signOutError && (
        <p role="alert" className="text-caption text-[var(--shell-danger)]">
          {signOutError}
        </p>
      )}
    </div>
  );
}

export default function Home() {
  const router = useRouter();
  const { viewer, loading, error } = useViewer();
  const accessible = viewer ? APPS.filter((a) => viewer.apps[a.id]?.access) : [];
  const anonymous = viewer?.mode === "anonymous";
  // A primitive dependency: the effect must re-run only when the answer changes, not on every render.
  const soleHref = accessible.length === 1 ? accessible[0].href : null;

  useEffect(() => {
    // `replace`, not `push`: the chooser was never a page the viewer chose, so Back should not return here.
    if (soleHref) router.replace(soleHref);
  }, [soleHref, router]);

  if (loading || soleHref) return <LandingSkeleton />;

  if (error) {
    return (
      <Frame>
        <div className="flex flex-col items-start gap-3 rounded-lg border border-[var(--shell-danger)] bg-[var(--shell-panel)] p-6">
          {/* The live region is the message; the buttons below it are not part of the announcement. */}
          <div role="alert" className="flex flex-col gap-3">
            <span className="flex items-center gap-2 text-title font-semibold">
              <AlertTriangle className="h-5 w-5 text-[var(--shell-danger)]" aria-hidden="true" />
              Could not load your console profile
            </span>
            <p className="text-label text-[var(--shell-ink-dim)]">{error}</p>
          </div>
          {/* The viewer is unknown here, so the mode is too; a failed `/api/me` in anonymous mode is a
              server-side configuration problem, and the sign-out control is the same dead end it would be
              anywhere else — but hiding it would also hide the only way out for a signed-in user. */}
          <CardActions anonymous={false} signInAgain />
        </div>
      </Frame>
    );
  }

  if (accessible.length === 0) {
    return (
      <Frame>
        <div className="flex flex-col items-start gap-3 rounded-lg border border-[var(--shell-line)] bg-[var(--shell-panel)] p-6">
          <div role="status" className="flex flex-col gap-3">
            <span className="flex items-center gap-2 text-title font-semibold">
              <Lock className="h-5 w-5 text-[var(--shell-ink-dim)]" aria-hidden="true" />
              No applications available
            </span>
            <p className="text-label text-[var(--shell-ink-dim)]">
              You do not have access to any application. Ask an administrator to add you to an access group.
            </p>
          </div>
          <CardActions anonymous={anonymous} />
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="mb-6">
        <h1 className="text-heading-lg font-semibold">Agentic Operations Console</h1>
        <p className="text-label text-[var(--shell-ink-dim)]">Choose an application to open.</p>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">
        {accessible.map((app) => (
          <AppCard key={app.id} app={app} />
        ))}
      </div>
    </Frame>
  );
}

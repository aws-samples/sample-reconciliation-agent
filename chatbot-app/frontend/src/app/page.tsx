"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, Lock } from "lucide-react";

import { signOut } from "@/components/AuthWrapper";
import { APP_ICONS } from "@/components/shell/AppRail";
import { APPS, type AppDefinition } from "@/lib/auth/apps";
import { useViewer } from "@/lib/shell/viewer";

// The console landing. Used to be a hard redirect to the recon dashboard; with two applications behind
// group-based access it has to ask first. One accessible app still behaves like the old redirect, so a
// deployment that runs only the reconciliation app sees no change.

/** Centered placeholder while the viewer loads (and while a single-app redirect is in flight). */
function LandingSkeleton() {
  return (
    <div
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
    </div>
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
    <div className="flex min-h-screen items-center justify-center bg-[var(--shell-bg)] p-8 text-[var(--shell-ink)]">
      <div className="w-full max-w-3xl">{children}</div>
    </div>
  );
}

function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => void signOut()}
      className="rounded-md border border-[var(--shell-line)] px-4 py-2 text-label hover:border-[var(--shell-accent)] hover:text-[var(--shell-accent)]"
    >
      Sign out
    </button>
  );
}

export default function Home() {
  const router = useRouter();
  const { viewer, loading, error } = useViewer();
  const accessible = viewer ? APPS.filter((a) => viewer.apps[a.id]?.access) : [];
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
        <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-[var(--shell-danger)] bg-[var(--shell-panel)] p-6">
          <span className="flex items-center gap-2 text-title font-semibold">
            <AlertTriangle className="h-5 w-5 text-[var(--shell-danger)]" aria-hidden="true" />
            Could not load your console profile
          </span>
          <p className="text-label text-[var(--shell-ink-dim)]">{error}</p>
          <SignOutButton />
        </div>
      </Frame>
    );
  }

  if (accessible.length === 0) {
    return (
      <Frame>
        <div role="status" className="flex flex-col items-start gap-3 rounded-lg border border-[var(--shell-line)] bg-[var(--shell-panel)] p-6">
          <span className="flex items-center gap-2 text-title font-semibold">
            <Lock className="h-5 w-5 text-[var(--shell-ink-dim)]" aria-hidden="true" />
            No applications available
          </span>
          <p className="text-label text-[var(--shell-ink-dim)]">
            You do not have access to any application. Ask an administrator to add you to an access group.
          </p>
          <SignOutButton />
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

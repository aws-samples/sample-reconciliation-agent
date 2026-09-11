"use client";

import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import type { ConsoleSettingsStore } from "@/components/console/useConsoleSettings";
import { BUTTON_QUIET, Note } from "@/components/console/primitives";

// What an admin section shows when it has no settings body: a skeleton while one is on its way, the
// server's reason when the request failed, and otherwise the read-only note plus whatever
// placeholders the section passes in — the STRUCTURE of the section (which variables exist, per
// app) is public knowledge from the registry, only the values are admins-only.

/** Placeholder rows while the settings load. */
export function SettingsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" data-testid="console-settings-skeleton" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-10 animate-pulse rounded-md bg-[var(--shell-panel)]" />
      ))}
    </div>
  );
}

export function AdminDataFallback({
  store,
  readOnlyNote,
  children,
}: {
  store: ConsoleSettingsStore;
  readOnlyNote: ReactNode;
  children: ReactNode;
}) {
  if (store.loading) return <SettingsSkeleton />;
  if (store.error) {
    return (
      <div className="flex flex-col gap-3">
        <Note tone="error" testId="console-settings-error">
          Could not load the console settings: {store.error}
        </Note>
        <button type="button" onClick={store.reload} className={`${BUTTON_QUIET} w-fit`}>
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Retry
        </button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {readOnlyNote}
      {children}
    </div>
  );
}

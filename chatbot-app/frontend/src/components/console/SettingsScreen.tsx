"use client";

import Link from "next/link";

import { AccessTab } from "@/components/console/AccessTab";
import { SettingsSkeleton } from "@/components/console/AdminDataFallback";
import { ApplicationsTab } from "@/components/console/ApplicationsTab";
import { DefaultsTab } from "@/components/console/DefaultsTab";
import { PreferencesTab } from "@/components/console/PreferencesTab";
import { Mono, Note } from "@/components/console/primitives";
import { SETTINGS_TABS, resolveSettingsTab, settingsTabHref, type SettingsTabId } from "@/components/console/tabs";
import { UsersTab } from "@/components/console/UsersTab";
import { useConsoleSettings } from "@/components/console/useConsoleSettings";
import { useViewer } from "@/lib/shell/viewer";
import { cn } from "@/lib/utils";

// The console Settings screen: one page, five sections chosen by `?tab=`.
//
// Not an application. It lives under the shell (rail on the left, no per-app access panel) and is
// reachable by every authenticated viewer, because everyone has Preferences; what the other sections
// allow depends on `viewer.console.admin` (edit) and `viewer.console.configured` (anywhere to store).

function TabsNav({ active }: { active: SettingsTabId }) {
  return (
    <nav aria-label="Settings sections" className="border-b border-[var(--shell-line)]">
      <ul className="flex flex-wrap gap-1">
        {SETTINGS_TABS.map((tab) => {
          const current = tab.id === active;
          return (
            <li key={tab.id}>
              <Link
                href={settingsTabHref(tab.id)}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex items-center border-b-2 px-3 py-2 text-label outline-none transition-colors",
                  "focus-visible:ring-2 focus-visible:ring-[var(--shell-accent)]",
                  current
                    ? "border-[var(--shell-accent)] text-[var(--shell-ink)]"
                    : "border-transparent text-[var(--shell-ink-dim)] hover:text-[var(--shell-ink)]",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function SettingsScreen({ tabParam }: { tabParam: string | null }) {
  const { viewer, loading, error } = useViewer();
  const admin = Boolean(viewer?.console.admin);
  // Only a console admin may read the settings body; asking for anyone else would only 403.
  const store = useConsoleSettings(Boolean(viewer) && admin);

  if (loading) {
    return (
      <div className="flex flex-col gap-6" data-testid="settings-screen-loading">
        <div className="h-8 w-64 animate-pulse rounded-md bg-[var(--shell-panel)]" />
        <SettingsSkeleton rows={4} />
      </div>
    );
  }

  if (!viewer) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-heading-lg font-semibold">Console settings</h1>
        <Note tone="error">Could not load your console profile, so nothing here can be shown. {error}</Note>
      </div>
    );
  }

  const tab = resolveSettingsTab(tabParam, admin);
  const current = SETTINGS_TABS.find((t) => t.id === tab) ?? SETTINGS_TABS[0];
  const configured = viewer.console.configured;
  const editable = admin && configured;
  const readOnlyNote = !admin ? (
    <Note tone="info" testId="read-only-note">
      Read-only. Console settings are changed by members of the console admin group, which the deployment names in{" "}
      <Mono>CONSOLE_ADMIN_GROUP</Mono>; membership is managed in the identity provider. You are signed in as{" "}
      <Mono>{viewer.subject || "unknown"}</Mono>.
    </Note>
  ) : !configured ? (
    <Note tone="warn" testId="read-only-note">
      Read-only. <Mono>CONSOLE_SETTINGS_PREFIX</Mono> is unset on this deployment, so there is nowhere to store a
      change: every value below comes from the environment or a built-in default, and the fields cannot be edited.
    </Note>
  ) : null;

  return (
    <div className="flex flex-col gap-6" data-testid="settings-screen">
      <header>
        <p className="text-caption uppercase tracking-[0.12em] text-[var(--shell-ink-dim)]">
          {viewer.console.organizationLabel || "Console"}
        </p>
        <h1 className="text-heading-lg font-semibold">Console settings</h1>
        <p className="mt-1 text-label text-[var(--shell-ink-dim)]">{current.description}</p>
      </header>
      <TabsNav active={tab} />
      {tab === "access" && <AccessTab store={store} editable={editable} readOnlyNote={readOnlyNote} />}
      {tab === "applications" && <ApplicationsTab store={store} editable={editable} readOnlyNote={readOnlyNote} />}
      {tab === "defaults" && <DefaultsTab store={store} editable={editable} readOnlyNote={readOnlyNote} />}
      {tab === "users" && <UsersTab viewer={viewer} store={store} />}
      {tab === "preferences" && <PreferencesTab viewer={viewer} />}
    </div>
  );
}

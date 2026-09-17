"use client";

import { useState } from "react";
import { useTheme } from "next-themes";

import { Field, INPUT_CLASS, Mono, Note, Section } from "@/components/console/primitives";
import { APPS, type AppId } from "@/lib/auth/apps";
import { putPreferences } from "@/lib/consoleApi";
import type { UserPreferences } from "@/lib/console/types";
import { THEME_OPTIONS, type ThemePreference } from "@/lib/shell/preferences";
import { readRailPreference, writeRailCollapsed } from "@/lib/shell/railState";
import { updateViewerPreferences, type ConsoleViewer } from "@/lib/shell/viewer";

// The Preferences section: the viewer's own defaults, written on every change.
//
// Each control applies its effect IMMEDIATELY and locally (the theme through next-themes, the rail
// through localStorage and the viewer store) and then, when the console has a server-side row,
// writes the whole preferences object. Local first, because the effect is what the user is looking
// at; the write second, because it may fail and the screen says so without undoing what they see.
// Without the stored layer the local effects are all there is, and the note says so.

const THEME_LABEL: Record<ThemePreference, string> = {
  system: "Follow the system",
  light: "Light",
  dark: "Dark",
};

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isTheme(value: string | undefined): value is ThemePreference {
  return (THEME_OPTIONS as readonly string[]).includes(value ?? "");
}

export function PreferencesTab({ viewer }: { viewer: ConsoleViewer }) {
  const { theme, setTheme } = useTheme();
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = viewer.console.configured;
  const prefs = viewer.preferences;
  const accessible = APPS.filter((a) => viewer.apps[a.id]?.access);

  /** Publish locally, then store when there is somewhere to store. */
  const persist = (next: UserPreferences) => {
    updateViewerPreferences(next);
    if (!configured) return;
    setBusy(true);
    setOutcome(null);
    putPreferences(next)
      .then(() => setOutcome({ tone: "success", text: "Saved." }))
      .catch((err: unknown) => setOutcome({ tone: "error", text: messageOf(err) }))
      .finally(() => setBusy(false));
  };

  const railCollapsed = prefs.railCollapsed ?? readRailPreference() ?? false;
  const currentTheme: ThemePreference = prefs.theme ?? (isTheme(theme) ? theme : "system");

  return (
    <Section title="Preferences" description="Your own defaults. Nobody else sees them, and they change nothing about access.">
      {!configured && (
        <Note tone="info" testId="preferences-browser-note">
          Preferences are kept in this browser only. <Mono>CONSOLE_SETTINGS_PREFIX</Mono> is unset on this
          deployment, so there is no server-side row: the rail state stays in this browser&rsquo;s storage, the theme
          follows this browser&rsquo;s setting, and a default application cannot be set.
        </Note>
      )}

      <Field
        id="pref-default-app"
        label="Default application"
        hint={
          accessible.length < 2
            ? "You have access to one application; the console opens it directly."
            : "Where the console opens from /. Ignored if you lose access to it."
        }
      >
        <select
          id="pref-default-app"
          className={INPUT_CLASS}
          value={prefs.defaultApp ?? ""}
          disabled={!configured || accessible.length < 2 || busy}
          onChange={(e) => {
            const next: UserPreferences = { ...prefs };
            const value = e.target.value as AppId | "";
            if (value) next.defaultApp = value;
            else delete next.defaultApp;
            persist(next);
          }}
        >
          <option value="">Show the chooser</option>
          {accessible.map((app) => (
            <option key={app.id} value={app.id}>
              {app.label}
            </option>
          ))}
        </select>
      </Field>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-label" htmlFor="pref-rail-collapsed">
          <input
            id="pref-rail-collapsed"
            type="checkbox"
            className="h-4 w-4 accent-[var(--shell-accent)]"
            checked={railCollapsed}
            disabled={busy}
            onChange={(e) => {
              // The browser copy first: it is what the next load paints before /api/me answers.
              writeRailCollapsed(e.target.checked);
              persist({ ...prefs, railCollapsed: e.target.checked });
            }}
          />
          Start with the navigation rail collapsed
        </label>
        <p className="text-caption text-[var(--shell-ink-dim)]">
          The rail&rsquo;s own button changes this too. Until you choose, the rail follows the window width.
        </p>
      </div>

      <Field
        id="pref-theme"
        label="Theme"
        hint={configured ? "Applied now and on every sign-in." : "Applied now; remembered by this browser."}
      >
        <select
          id="pref-theme"
          className={INPUT_CLASS}
          value={currentTheme}
          disabled={busy}
          onChange={(e) => {
            const value = e.target.value as ThemePreference;
            setTheme(value);
            persist({ ...prefs, theme: value });
          }}
        >
          {THEME_OPTIONS.map((t) => (
            <option key={t} value={t}>
              {THEME_LABEL[t]}
            </option>
          ))}
        </select>
      </Field>

      {outcome && (
        <Note tone={outcome.tone} testId="preferences-outcome">
          {outcome.text}
        </Note>
      )}
    </Section>
  );
}

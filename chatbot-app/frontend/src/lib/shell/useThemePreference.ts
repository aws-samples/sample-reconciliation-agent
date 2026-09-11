"use client";

import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

import type { ConsoleViewer } from "@/lib/shell/viewer";

// Apply the viewer's stored theme to next-themes, once per viewer load.
//
// next-themes keeps its own copy in localStorage and applies it before hydration, so the browser
// value is what the first paint uses; the stored value then wins ONCE when `/api/me` answers, and
// after that the user is free to change it (the Preferences screen writes both). Keyed on the viewer
// OBJECT rather than the theme string: a reload of `/api/me` publishes a new object and re-applies,
// which is the "once per load" the shell promises, while a stale object never re-applies over a
// choice the user made since.

/**
 * Set the next-themes theme from `viewer.preferences.theme` when a viewer arrives.
 *
 * @param viewer the console viewer once known; nothing happens while `null` or when no theme is stored.
 */
export function useThemePreference(viewer: ConsoleViewer | null): void {
  const { setTheme } = useTheme();
  const applied = useRef<ConsoleViewer | null>(null);
  useEffect(() => {
    if (!viewer || applied.current === viewer) return;
    applied.current = viewer;
    if (viewer.preferences.theme) setTheme(viewer.preferences.theme);
  }, [viewer, setTheme]);
}

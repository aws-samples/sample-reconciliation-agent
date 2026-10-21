"use client";

import { useCallback, useEffect, useState } from "react";

import { getConsoleSettings, updateConsoleSettings } from "@/lib/consoleApi";
import type { ConsoleSettings, ConsoleSettingsUpdate } from "@/lib/console/types";

// The console settings body for the Settings screen: loaded once per screen mount for a console
// admin, replaced wholesale by every successful save.
//
// Replaced by the RESPONSE rather than patched with the request: the chips must show where each
// value now comes from, and only the server knows that once the parameters are written ("" may have
// cleared a stored value and exposed an env one, or nothing at all).

export interface ConsoleSettingsStore {
  /** The settings once loaded; `null` while loading, after a failure, or when the viewer may not read them. */
  settings: ConsoleSettings | null;
  loading: boolean;
  /** Why there are no settings, for display. */
  error: string | null;
  saving: boolean;
  /**
   * Write `update` and adopt the refreshed settings.
   *
   * @returns the refreshed settings.
   * @throws with the server's message; the caller shows it beside its Save button.
   */
  save: (update: ConsoleSettingsUpdate) => Promise<ConsoleSettings>;
  /** Ask again after a failure. */
  reload: () => void;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load (when `enabled`) and save the console settings.
 *
 * @param enabled whether to request them at all. `GET /api/console/settings` is admins-only, so a
 *   non-admin viewer must not trigger a request that can only 403; the screen shows placeholders.
 *   `loading` is derived from `enabled` rather than kept as state so that the render in which
 *   `enabled` flips on already reads as loading, instead of one frame of "nothing to show".
 */
export function useConsoleSettings(enabled: boolean): ConsoleSettingsStore {
  const [settings, setSettings] = useState<ConsoleSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setError(null);
    getConsoleSettings().then(
      (body) => {
        if (live) setSettings(body);
      },
      (err: unknown) => {
        if (live) setError(messageOf(err));
      },
    );
    return () => {
      // A screen unmounted mid-request must not set state on its way out.
      live = false;
    };
  }, [enabled, attempt]);

  const save = useCallback(async (update: ConsoleSettingsUpdate): Promise<ConsoleSettings> => {
    setSaving(true);
    try {
      const next = await updateConsoleSettings(update);
      setSettings(next);
      return next;
    } finally {
      setSaving(false);
    }
  }, []);

  const reload = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { settings, loading: enabled && settings === null && error === null, error, saving, save, reload };
}

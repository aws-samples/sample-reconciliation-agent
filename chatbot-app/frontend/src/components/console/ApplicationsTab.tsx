"use client";

import { useEffect, useState, type FormEvent } from "react";

import { type AdminTabProps, UpdatedLine } from "@/components/console/AccessTab";
import { AdminDataFallback } from "@/components/console/AdminDataFallback";
import { BUTTON_PRIMARY, BUTTON_QUIET, Mono, Note, Section, SourceChip } from "@/components/console/primitives";
import { APPS, type AppId } from "@/lib/auth/apps";
import type { ConsoleSettings, ConsoleSettingsUpdate } from "@/lib/console/types";

// The Applications section: an enabled switch for every app that has one.
//
// Only apps with an `enabledEnv` appear as switches (`settings.apps` omits the others); an app
// without one is always part of the console and is listed as such, so the section never suggests a
// switch that does not exist. Saving is a button, not the checkbox itself, so the warning about
// what disabling does is read before anything is written.

type EnabledDraft = Partial<Record<AppId, boolean>>;

function draftFrom(settings: ConsoleSettings): EnabledDraft {
  const out: EnabledDraft = {};
  for (const app of APPS) {
    const entry = settings.apps[app.id];
    if (entry) out[app.id] = entry.enabled.value === "true";
  }
  return out;
}

/** Only the switches the operator flipped, as a PUT body; `undefined` when none. */
export function enablementUpdateFrom(initial: EnabledDraft, draft: EnabledDraft): ConsoleSettingsUpdate | undefined {
  const apps: NonNullable<ConsoleSettingsUpdate["apps"]> = {};
  let changed = false;
  for (const app of APPS) {
    const before = initial[app.id];
    const after = draft[app.id];
    if (before !== undefined && after !== undefined && before !== after) {
      apps[app.id] = { enabled: after };
      changed = true;
    }
  }
  return changed ? { apps } : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function Placeholders() {
  return (
    <ul className="flex flex-col gap-2 text-label text-[var(--shell-ink-dim)]">
      {APPS.map((app) => (
        <li key={app.id}>
          <span className="text-[var(--shell-ink)]">{app.label}</span>:{" "}
          {app.enabledEnv ? (
            <>
              switched by <Mono>{app.enabledEnv}</Mono> (state visible to console admins).
            </>
          ) : (
            "always part of the console."
          )}
        </li>
      ))}
    </ul>
  );
}

export function ApplicationsTab({ store, editable, readOnlyNote }: AdminTabProps) {
  const { settings, saving, save } = store;
  const [draft, setDraft] = useState<EnabledDraft | null>(settings ? draftFrom(settings) : null);
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setDraft(settings ? draftFrom(settings) : null);
  }, [settings]);

  if (!settings || !draft) {
    return (
      <Section title="Applications" description={DESCRIPTION}>
        <AdminDataFallback store={store} readOnlyNote={readOnlyNote}>
          <Placeholders />
        </AdminDataFallback>
      </Section>
    );
  }

  const initial = draftFrom(settings);
  const update = enablementUpdateFrom(initial, draft);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!update) return;
    setOutcome(null);
    try {
      await save(update);
      setOutcome({ tone: "success", text: "Saved. The rail and the API gate follow on the next request." });
    } catch (err) {
      setOutcome({ tone: "error", text: messageOf(err) });
    }
  };

  return (
    <Section title="Applications" description={DESCRIPTION}>
      {!editable && readOnlyNote}
      <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Applications form">
        {APPS.map((app) => {
          const entry = settings.apps[app.id];
          if (!entry) {
            return (
              <div
                key={app.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--shell-line)] p-4"
                data-testid={`${app.id}-always-enabled`}
              >
                <span className="text-label font-semibold">{app.label}</span>
                <span className="text-caption text-[var(--shell-ink-dim)]">Always part of the console</span>
              </div>
            );
          }
          const checked = draft[app.id] ?? entry.enabled.value === "true";
          return (
            <fieldset
              key={app.id}
              className="flex flex-col gap-3 rounded-md border border-[var(--shell-line)] p-4"
              disabled={saving}
            >
              <legend className="px-1 text-label font-semibold">{app.label}</legend>
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-label" htmlFor={`${app.id}-enabled`}>
                  <input
                    id={`${app.id}-enabled`}
                    type="checkbox"
                    checked={checked}
                    disabled={!editable}
                    onChange={(e) => setDraft((d) => ({ ...(d ?? {}), [app.id]: e.target.checked }))}
                    className="h-4 w-4 accent-[var(--shell-accent)]"
                  />
                  Enabled
                </label>
                <SourceChip setting={entry.enabled} testId={`${app.id}-enabled-source`} />
              </div>
              <Note tone={checked ? "info" : "warn"} testId={`${app.id}-enabled-warning`}>
                Disabling hides {app.label} from <strong>every</strong> viewer, including its administrators, and
                its API answers 403 until it is enabled again. Falls back to{" "}
                <Mono>{entry.enabled.envName ?? app.enabledEnv}</Mono>.
              </Note>
            </fieldset>
          );
        })}
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={BUTTON_PRIMARY} disabled={!update || saving}>
              {saving ? "Saving…" : "Save applications"}
            </button>
            <button
              type="button"
              className={BUTTON_QUIET}
              disabled={!update || saving}
              onClick={() => {
                setDraft(initial);
                setOutcome(null);
              }}
            >
              Discard changes
            </button>
          </div>
        )}
        {outcome && (
          <Note tone={outcome.tone} testId="applications-outcome">
            {outcome.text}
          </Note>
        )}
        <UpdatedLine settings={settings} />
      </form>
    </Section>
  );
}

const DESCRIPTION =
  "Which applications this console serves. A disabled application is absent from the rail and the chooser for everyone, and every request to its API answers 403.";

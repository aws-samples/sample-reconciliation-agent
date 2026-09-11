"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { AdminDataFallback } from "@/components/console/AdminDataFallback";
import {
  BUTTON_PRIMARY,
  BUTTON_QUIET,
  Field,
  INPUT_CLASS,
  Mono,
  Note,
  Section,
  SourceChip,
} from "@/components/console/primitives";
import type { ConsoleSettingsStore } from "@/components/console/useConsoleSettings";
import { APPS } from "@/lib/auth/apps";
import type { ConsoleSettings } from "@/lib/console/types";
import {
  accessDraftError,
  accessDraftFrom,
  accessUpdateFrom,
  groupNameError,
  type AccessDraft,
} from "@/lib/shell/consoleSettingsForm";

// The Access section: one access group and one admin group per application.
//
// The inputs show RESOLVED values, whatever their source, so an operator sees what is in force; the
// chip beside each says where it came from. Saving sends only what changed, so an env value that was
// merely displayed never turns into a stored one (see `accessUpdateFrom`).

export interface AdminTabProps {
  store: ConsoleSettingsStore;
  /** Whether fields may be edited: a console admin, and the stored layer configured. */
  editable: boolean;
  /** Why they may not be, when `editable` is false; rendered at the top of the section. */
  readOnlyNote: ReactNode;
}

interface Outcome {
  tone: "success" | "error";
  text: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "Last saved" line, when the server knows. */
export function UpdatedLine({ settings }: { settings: ConsoleSettings }) {
  if (!settings.updatedAt) return null;
  return (
    <p className="text-caption text-[var(--shell-ink-dim)]" data-testid="updated-line">
      Last saved {new Date(settings.updatedAt).toLocaleString()}
      {settings.updatedBy ? (
        <>
          {" "}
          by <Mono>{settings.updatedBy}</Mono>
        </>
      ) : null}
    </p>
  );
}

/** The section without its values: which variables exist per app, for a viewer who may not read them. */
function AccessPlaceholders() {
  return (
    <ul className="flex flex-col gap-2 text-label text-[var(--shell-ink-dim)]">
      {APPS.map((app) => (
        <li key={app.id}>
          <span className="text-[var(--shell-ink)]">{app.label}</span>: access group from{" "}
          <Mono>{app.accessGroupEnv}</Mono>, admin group from <Mono>{app.adminGroupEnv}</Mono> (values
          visible to console admins).
        </li>
      ))}
    </ul>
  );
}

export function AccessTab({ store, editable, readOnlyNote }: AdminTabProps) {
  const { settings, saving, save } = store;
  const [draft, setDraft] = useState<AccessDraft | null>(settings ? accessDraftFrom(settings) : null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    // Every new settings body (load, or the refreshed answer to a save) resets the inputs to what is in
    // force; an edit in progress is superseded by the truth the server just reported.
    setDraft(settings ? accessDraftFrom(settings) : null);
  }, [settings]);

  if (!settings || !draft) {
    return (
      <Section title="Access groups" description={TAB_DESCRIPTION}>
        <AdminDataFallback store={store} readOnlyNote={readOnlyNote}>
          <AccessPlaceholders />
        </AdminDataFallback>
      </Section>
    );
  }

  const initial = accessDraftFrom(settings);
  const update = accessUpdateFrom(initial, draft);
  const validation = accessDraftError(draft);
  const requireGroups = settings.envOnly.requireAccessGroups;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!update || validation) return;
    setOutcome(null);
    try {
      await save(update);
      setOutcome({ tone: "success", text: "Saved. Each source chip now shows where the value in force comes from." });
    } catch (err) {
      setOutcome({ tone: "error", text: messageOf(err) });
    }
  };

  const set = (appId: (typeof APPS)[number]["id"], key: "accessGroup" | "adminGroup", value: string) =>
    setDraft((d) => (d ? { ...d, [appId]: { ...d[appId], [key]: value } } : d));

  return (
    <Section title="Access groups" description={TAB_DESCRIPTION}>
      {!editable && readOnlyNote}
      <Note tone="info">
        Admins implicitly have access. A blank access group{" "}
        {requireGroups ? (
          <>
            <strong>denies</strong> the application to everyone but its admins, because{" "}
            <Mono>REQUIRE_ACCESS_GROUPS</Mono> is true on this deployment.
          </>
        ) : (
          <>
            leaves the application <strong>open</strong> to every authenticated user, because{" "}
            <Mono>REQUIRE_ACCESS_GROUPS</Mono> is not set on this deployment.
          </>
        )}{" "}
        Clearing a field removes the stored value and falls back to the environment variable named under it.
      </Note>
      <form onSubmit={submit} className="flex flex-col gap-5" aria-label="Access groups form">
        {APPS.map((app) => {
          const entry = settings.access[app.id];
          const accessError = groupNameError(draft[app.id].accessGroup);
          const adminError = groupNameError(draft[app.id].adminGroup);
          return (
            <fieldset
              key={app.id}
              className="flex flex-col gap-3 rounded-md border border-[var(--shell-line)] p-4"
              disabled={saving}
            >
              <legend className="px-1 text-label font-semibold">{app.label}</legend>
              <Field
                id={`${app.id}-access-group`}
                label="Access group"
                hint={
                  <>
                    Falls back to <Mono>{entry.accessGroup.envName ?? app.accessGroupEnv}</Mono>.
                  </>
                }
                error={accessError}
                trailing={<SourceChip setting={entry.accessGroup} testId={`${app.id}-access-group-source`} />}
              >
                <input
                  id={`${app.id}-access-group`}
                  className={INPUT_CLASS}
                  value={draft[app.id].accessGroup}
                  onChange={(e) => set(app.id, "accessGroup", e.target.value)}
                  readOnly={!editable}
                  aria-readonly={!editable || undefined}
                  aria-invalid={accessError ? true : undefined}
                  aria-describedby={accessError ? `${app.id}-access-group-error` : `${app.id}-access-group-hint`}
                  placeholder={editable ? "blank = fall back to the environment" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
              <Field
                id={`${app.id}-admin-group`}
                label="Admin group"
                hint={
                  <>
                    Falls back to <Mono>{entry.adminGroup.envName ?? app.adminGroupEnv}</Mono>. Blank means nobody
                    administers this application.
                  </>
                }
                error={adminError}
                trailing={<SourceChip setting={entry.adminGroup} testId={`${app.id}-admin-group-source`} />}
              >
                <input
                  id={`${app.id}-admin-group`}
                  className={INPUT_CLASS}
                  value={draft[app.id].adminGroup}
                  onChange={(e) => set(app.id, "adminGroup", e.target.value)}
                  readOnly={!editable}
                  aria-readonly={!editable || undefined}
                  aria-invalid={adminError ? true : undefined}
                  aria-describedby={adminError ? `${app.id}-admin-group-error` : `${app.id}-admin-group-hint`}
                  placeholder={editable ? "blank = fall back to the environment" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </fieldset>
          );
        })}
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className={BUTTON_PRIMARY} disabled={!update || Boolean(validation) || saving}>
              {saving ? "Saving…" : "Save access groups"}
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
          <Note tone={outcome.tone} testId="access-outcome">
            {outcome.text}
          </Note>
        )}
        <UpdatedLine settings={settings} />
      </form>
    </Section>
  );
}

const TAB_DESCRIPTION =
  "Which identity-provider group may use each application, and which may change how it behaves. Membership itself is managed in the identity provider.";

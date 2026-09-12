"use client";

import { useEffect, useState, type FormEvent } from "react";

import { type AdminTabProps, UpdatedLine } from "@/components/console/AccessTab";
import { AdminDataFallback } from "@/components/console/AdminDataFallback";
import { MODEL_ENDPOINTS, MODEL_FAMILIES, composeModelId, splitModelId } from "@/lib/models/presets";
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
import { ORGANIZATION_LABEL_MAX, type ConsoleSettings, type ConsoleSettingsUpdate } from "@/lib/console/types";
import { modelIdError, organizationLabelError } from "@/lib/shell/consoleSettingsForm";
import { cn } from "@/lib/utils";

// The Defaults section: the model id the apps may inherit, and the organization label under the mark.
//
// The model id takes the same family-plus-endpoint presets as the apps' Config tabs, composed into
// one id that is always visible, PLUS a free-text field: a console default may be an inference
// profile no preset names, and the apps only ever read the final string.

interface DefaultsDraft {
  modelId: string;
  organizationLabel: string;
}

function draftFrom(settings: ConsoleSettings): DefaultsDraft {
  return {
    modelId: settings.defaults.modelId.value,
    organizationLabel: settings.defaults.organizationLabel.value,
  };
}

/** Only the changed fields, as a PUT body; `undefined` when nothing changed. */
export function defaultsUpdateFrom(initial: DefaultsDraft, draft: DefaultsDraft): ConsoleSettingsUpdate | undefined {
  const defaults: NonNullable<ConsoleSettingsUpdate["defaults"]> = {};
  if (draft.modelId !== initial.modelId) defaults.modelId = draft.modelId;
  if (draft.organizationLabel !== initial.organizationLabel) defaults.organizationLabel = draft.organizationLabel;
  return Object.keys(defaults).length > 0 ? { defaults } : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One row of preset buttons, the pattern the apps' Config tabs use. */
function Choice<T extends string>({
  options,
  value,
  onChange,
  disabled,
  name,
}: {
  options: readonly { value: T; label: string; hint?: string }[];
  value: string;
  onChange: (v: T) => void;
  disabled: boolean;
  name: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={name}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={disabled}
          title={o.hint ?? o.value}
          aria-pressed={value === o.value}
          className={cn(
            "rounded-md border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] disabled:opacity-40",
            value === o.value
              ? "border-[var(--shell-accent)] bg-[var(--shell-accent-soft)] text-[var(--shell-ink)]"
              : "border-[var(--shell-line)] text-[var(--shell-ink-dim)] hover:text-[var(--shell-ink)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Placeholders() {
  return (
    <ul className="flex flex-col gap-2 text-label text-[var(--shell-ink-dim)]">
      <li>
        <span className="text-[var(--shell-ink)]">Default model</span>: the Bedrock model or inference-profile id an
        application may inherit when its own parameter is blank (value visible to console admins).
      </li>
      <li>
        <span className="text-[var(--shell-ink)]">Organization label</span>: the name under the console mark in the
        rail.
      </li>
    </ul>
  );
}

export function DefaultsTab({ store, editable, readOnlyNote }: AdminTabProps) {
  const { settings, saving, save } = store;
  const [draft, setDraft] = useState<DefaultsDraft | null>(settings ? draftFrom(settings) : null);
  const [outcome, setOutcome] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    setDraft(settings ? draftFrom(settings) : null);
  }, [settings]);

  if (!settings || !draft) {
    return (
      <Section title="Defaults" description={DESCRIPTION}>
        <AdminDataFallback store={store} readOnlyNote={readOnlyNote}>
          <Placeholders />
        </AdminDataFallback>
      </Section>
    );
  }

  const initial = draftFrom(settings);
  const update = defaultsUpdateFrom(initial, draft);
  const modelError = modelIdError(draft.modelId);
  const labelError = organizationLabelError(draft.organizationLabel);
  // Blanks, not the deployed default, for an id no preset covers: a free-text id must not light up
  // a preset it does not match.
  const { endpoint, family } = splitModelId(draft.modelId, null);
  const modelSetting = settings.defaults.modelId;
  const labelSetting = settings.defaults.organizationLabel;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!update || modelError || labelError) return;
    setOutcome(null);
    try {
      await save(update);
      setOutcome({ tone: "success", text: "Saved. The rail picks up the label on its next load." });
    } catch (err) {
      setOutcome({ tone: "error", text: messageOf(err) });
    }
  };

  const setModel = (id: string) => setDraft((d) => (d ? { ...d, modelId: id } : d));

  return (
    <Section title="Defaults" description={DESCRIPTION}>
      {!editable && readOnlyNote}
      <form onSubmit={submit} className="flex flex-col gap-5" aria-label="Defaults form">
        <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--shell-line)] p-4" disabled={saving}>
          <legend className="px-1 text-label font-semibold">Default model</legend>
          <Choice
            name="Model family"
            options={MODEL_FAMILIES.map((f) => ({ value: f.suffix, label: f.label }))}
            value={family}
            disabled={!editable}
            onChange={(f) => setModel(composeModelId(endpoint || MODEL_ENDPOINTS[0].value, f))}
          />
          <Choice
            name="Endpoint"
            options={MODEL_ENDPOINTS}
            value={endpoint}
            disabled={!editable}
            onChange={(e) => setModel(composeModelId(e, family || MODEL_FAMILIES[1].suffix))}
          />
          <Field
            id="default-model-id"
            label="Model id"
            error={modelError}
            hint={
              <>
                Blank means no console default: each application uses its own parameter.{" "}
                {modelSetting.envName ? (
                  <>
                    Falls back to <Mono>{modelSetting.envName}</Mono>.
                  </>
                ) : null}{" "}
                The <Mono>global.</Mono> endpoint may serve requests from outside the US: a data-residency
                choice, not a speed one.
              </>
            }
            trailing={<SourceChip setting={modelSetting} testId="default-model-id-source" />}
          >
            <div className="flex gap-2">
              <input
                id="default-model-id"
                className={INPUT_CLASS}
                value={draft.modelId}
                onChange={(e) => setModel(e.target.value.trim())}
                readOnly={!editable}
                aria-readonly={!editable || undefined}
                aria-invalid={modelError ? true : undefined}
                aria-describedby={modelError ? "default-model-id-error" : "default-model-id-hint"}
                placeholder={editable ? "e.g. us.anthropic.claude-sonnet-5" : undefined}
                autoComplete="off"
                spellCheck={false}
              />
              {editable && (
                <button
                  type="button"
                  className={BUTTON_QUIET}
                  onClick={() => setModel("")}
                  disabled={draft.modelId === ""}
                  aria-label="Clear the default model"
                >
                  Clear
                </button>
              )}
            </div>
          </Field>
        </fieldset>

        <fieldset className="flex flex-col gap-3 rounded-md border border-[var(--shell-line)] p-4" disabled={saving}>
          <legend className="px-1 text-label font-semibold">Organization label</legend>
          <Field
            id="organization-label"
            label="Label under the console mark"
            error={labelError}
            hint={
              <>
                {draft.organizationLabel.length}/{ORGANIZATION_LABEL_MAX} characters. Blank shows “Console”.{" "}
                {labelSetting.envName ? (
                  <>
                    Falls back to <Mono>{labelSetting.envName}</Mono>.
                  </>
                ) : null}
              </>
            }
            trailing={<SourceChip setting={labelSetting} testId="organization-label-source" />}
          >
            <input
              id="organization-label"
              className={INPUT_CLASS}
              value={draft.organizationLabel}
              onChange={(e) => setDraft((d) => (d ? { ...d, organizationLabel: e.target.value } : d))}
              readOnly={!editable}
              aria-readonly={!editable || undefined}
              aria-invalid={labelError ? true : undefined}
              aria-describedby={labelError ? "organization-label-error" : "organization-label-hint"}
              placeholder={editable ? "e.g. Meridian Capital Operations" : undefined}
              autoComplete="off"
            />
          </Field>
        </fieldset>

        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className={BUTTON_PRIMARY}
              disabled={!update || Boolean(modelError) || Boolean(labelError) || saving}
            >
              {saving ? "Saving…" : "Save defaults"}
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
          <Note tone={outcome.tone} testId="defaults-outcome">
            {outcome.text}
          </Note>
        )}
        <UpdatedLine settings={settings} />
      </form>
    </Section>
  );
}

const DESCRIPTION =
  "Values the applications may inherit when their own configuration is blank, and how this console names itself in the rail.";

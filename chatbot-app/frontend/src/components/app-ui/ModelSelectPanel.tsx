"use client";

import { useState, type ReactNode } from "react";

import { Placeholder } from "@/components/app-ui/ui";
import {
  MODEL_ENDPOINTS,
  MODEL_FAMILIES,
  composeModelId,
  splitModelId,
  type ModelIdParts,
} from "@/lib/models/presets";

// The model-selection row both apps' Config tabs mount: one family control, one endpoint control, the
// id they compose into, and Apply.
//
// Three things about the control are load-bearing, and the tests for both pages pin them:
//
//   1. the two controls COMPOSE into one id, and that id is on screen before anything is written —
//      half the available pairs are a data-residency change, and a click-by-click save would write
//      intermediate pairs nobody chose;
//   2. Apply is withheld while the selection is clean and while the composed pair is outside what the
//      SERVER said it accepts. The BFF allowlist, the Python one and the preset table here are
//      hand-maintained copies, so a drifted pair must surface as "not an accepted combination" rather
//      than as a 400 after the click;
//   3. no recorded selection is reported as such, in the caller's words, rather than as whichever id
//      this panel would have guessed.
//
// Controlled on purpose. The panel owns only the operator's pending pick; the SAVED value, the
// allowlist, the in-flight flag and the outcome line belong to the page, because a page has one `busy`
// for every control on it (a model save must not race a backend switch) and its own wording for a
// success. `onApply` is handed the composed id and the page does the write.

export interface ModelSelectPanelProps {
  /** The SAVED selection: null when nothing is recorded and the agent runs its deployed default. */
  value: string | null;
  /**
   * Whether the config has arrived. Until it has, the controls are disabled and the id line reads
   * "loading…": neither a guessed id nor the "no selection" line, because nothing is known yet.
   */
  loaded: boolean;
  /** The ids the server accepts. Empty means the server reported none, and every pair is offered. */
  allowed: readonly string[];
  /**
   * The console-wide default model id, when the console has one and the caller's route reports it.
   * Shown beside the controls with a one-click fill; the write is still `onApply` of THIS app's id.
   */
  consoleDefault?: string | null;
  /**
   * What runs when `value` is null, as the tail of "No selection recorded — …". The caller's words,
   * because the default lives in each agent's own environment and only the caller knows what it is
   * (or that it cannot know).
   */
  deployedDefault: ReactNode;
  /** Called with the composed id when Apply is pressed. The page saves, and sets `value` on success. */
  onApply: (modelId: string) => void | Promise<void>;
  /** The viewer may look but not change: controls disabled, Apply and the console-default fill withheld. */
  readOnly?: boolean;
  /** A save is in flight somewhere on the page: controls disabled, Apply shown but disabled. */
  busy?: boolean;
  /** The config could not be loaded: shown in place of the controls. */
  error?: string | null;
  /** The heading over the description. */
  title?: ReactNode;
  /** The copy under the title: what the model drives and when a change takes effect. */
  description: ReactNode;
}

const FAMILY_OPTIONS = MODEL_FAMILIES.map((f) => ({
  value: f.suffix,
  label: f.label,
}));

/** One row of preset buttons. The hint (or the value) is the tooltip. */
function Choice<T extends string>({
  name,
  options,
  value,
  onChange,
  disabled,
}: {
  name: string;
  options: readonly { value: T; label: string; hint?: string }[];
  value: string;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2" role="group" aria-label={name}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={disabled}
          title={o.hint ?? o.value}
          aria-pressed={value === o.value}
          className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
          style={{
            color: value === o.value ? "var(--rc-ink)" : "var(--rc-ink-faint)",
            background: value === o.value ? "var(--rc-panel-2)" : "transparent",
            border:
              value === o.value
                ? "1px solid var(--rc-cyan)"
                : "1px solid var(--rc-line)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ModelSelectPanel({
  value,
  loaded,
  allowed,
  consoleDefault,
  deployedDefault,
  onApply,
  readOnly = false,
  busy = false,
  error,
  title = "Model",
  description,
}: ModelSelectPanelProps) {
  // The operator's pick, null until they touch a control. Until then the controls follow the saved
  // value — which is also what they show after a save lands, since the page sets `value` to the id
  // that was applied.
  const [pick, setPick] = useState<ModelIdParts | null>(null);
  const shown = pick ?? splitModelId(value);
  // Composed from the two controls. Deliberately NOT written as it changes.
  const pending = composeModelId(shown.endpoint, shown.family);
  const pendingAllowed =
    !loaded || allowed.length === 0 || allowed.includes(pending);
  const dirty = loaded && pending !== value;
  const disabled = busy || !loaded || readOnly;

  // A stored id outside the presets (a bare foundation-model id, say) still shows as the resolved id,
  // so the panel never claims a selection it cannot represent with its buttons.
  const stored = splitModelId(value, null);
  const storedIsPreset =
    value === null ||
    (MODEL_FAMILIES.some((f) => f.suffix === stored.family) &&
      MODEL_ENDPOINTS.some((e) => e.value === stored.endpoint));

  /** Fill the two controls from the console default; the composed id then equals it exactly. */
  const useConsoleDefault = () => {
    if (!consoleDefault) return;
    setPick(splitModelId(consoleDefault));
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
            {title}
          </div>
          <div className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
            {description}
          </div>
        </div>

        {error ? (
          <Placeholder kind="error">Failed to load — {error}</Placeholder>
        ) : (
          <div className="flex flex-col items-end gap-2">
            <Choice
              name="Model family"
              options={FAMILY_OPTIONS}
              value={shown.family}
              onChange={(family) => setPick({ ...shown, family })}
              disabled={disabled}
            />
            <Choice
              name="Endpoint"
              options={MODEL_ENDPOINTS}
              value={shown.endpoint}
              onChange={(endpoint) => setPick({ ...shown, endpoint })}
              disabled={disabled}
            />
            {/* The resolved id, always visible. The two controls compose into it, so an operator who
                cannot see the result cannot tell a family change from a residency change. */}
            <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              {loaded ? pending : "loading…"}
            </span>
            {!readOnly && dirty && pendingAllowed && (
              <button
                type="button"
                onClick={() => void onApply(pending)}
                disabled={busy}
                className="rc-mono rounded border border-[var(--rc-cyan)] bg-[var(--rc-panel-2)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--rc-ink)] disabled:opacity-40"
              >
                Apply
              </button>
            )}
            {dirty && !pendingAllowed && (
              <span className="rc-mono text-[11px] text-[var(--rc-amber)]">
                not an accepted combination
              </span>
            )}
          </div>
        )}
      </div>

      {/* No selection recorded is a real state, not a missing value: the agent runs whatever it was
          deployed with. Saying so, in the caller's words, beats naming an id this panel cannot verify. */}
      {loaded && value === null && (
        <p className="rc-mono mt-3 text-[11px] text-[var(--rc-ink-faint)]">
          No selection recorded — {deployedDefault}
        </p>
      )}
      {loaded && !storedIsPreset && (
        <p className="rc-mono mt-3 text-[11px] text-[var(--rc-amber)]">
          The stored id, {value}, is not one of the presets above; applying a
          preset replaces it.
        </p>
      )}
      {loaded && consoleDefault && (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[var(--rc-ink-faint)]"
          data-testid="console-default-model"
        >
          <span className="rc-mono">
            Console default:{" "}
            <span className="text-[var(--rc-ink-dim)]">{consoleDefault}</span>
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={useConsoleDefault}
              disabled={busy || pending === consoleDefault}
              className="rc-mono rounded border border-[var(--rc-line)] px-3 py-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)] disabled:opacity-40"
            >
              Use console default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

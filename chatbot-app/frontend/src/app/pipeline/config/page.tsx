"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getConfig, saveConfig } from "@/lib/pipelineApi";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import { Eyebrow, Notice, Panel, Placeholder, type ActionOutcome } from "@/components/app-ui/ui";

// A model id is one family plus one endpoint, composed rather than listed: the two are independent
// choices with different consequences, and a flat list of six ids invites reading `global.` as a
// capability tier. The hints are the family's own profile id — factual, and the string that appears
// in traces and Bedrock metrics — rather than a capability ranking this UI is in no position to
// assert.
//
// The GET may also return the ids the PUT accepts; when it does, the composed value is checked against
// them before Apply is offered, so a family listed here but refused there cannot be saved.
const MODEL_FAMILIES = [
  { suffix: "anthropic.claude-opus-5", label: "Opus 5" },
  { suffix: "anthropic.claude-sonnet-5", label: "Sonnet 5" },
  { suffix: "anthropic.claude-fable-5-1", label: "Fable 5.1" },
];

// Not a speed or price tier. `global.` may serve the request from a region outside the US, which is a
// data-residency decision and is invisible in the id — so it is spelled out here rather than left to
// be inferred from a name that looks like a performance setting.
const MODEL_ENDPOINTS = [
  { value: "us", label: "US", hint: "inference served from US regions only" },
  {
    value: "global",
    label: "Global",
    hint: "may serve the request from outside the US (data residency, not latency)",
  },
];

/** The deployed default (design §3), pre-selected when the parameter holds nothing yet. */
const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-5";

/** The family/endpoint pair a stored model id decomposes into, for pre-selecting the controls. */
function splitModelId(modelId: string | null): { endpoint: string; family: string } {
  const id = modelId ?? DEFAULT_MODEL_ID;
  const dot = id.indexOf(".");
  return { endpoint: id.slice(0, dot), family: id.slice(dot + 1) };
}

/** One row of preset buttons. */
function Choice<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: string;
  onChange: (v: T) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          disabled={disabled}
          title={o.hint ?? o.value}
          className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
          style={{
            color: value === o.value ? "var(--rc-ink)" : "var(--rc-ink-faint)",
            background: value === o.value ? "var(--rc-panel-2)" : "transparent",
            border: value === o.value ? "1px solid var(--rc-cyan)" : "1px solid var(--rc-line)",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function ConfigPage() {
  const { isAdmin } = usePipelineSubject();
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The SAVED selection, and the family/endpoint the controls currently show. Separate because the two
  // controls compose into one id: picking a family has not chosen anything until the pair is applied,
  // and showing the composed id before the write is the point — "Opus" plus "Global" is a
  // data-residency change the operator should see spelled out first.
  const [modelId, setModelId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<readonly string[]>([]);
  // The console-wide default model, when the console has one (`/console/settings`, Defaults). Offered as
  // a one-click fill for the controls; Apply still writes THIS app's parameter, because the parser reads
  // that parameter and nothing else.
  const [consoleDefault, setConsoleDefault] = useState<string | null>(null);
  const [family, setFamily] = useState(splitModelId(null).family);
  const [endpoint, setEndpoint] = useState(splitModelId(null).endpoint);
  const [busy, setBusy] = useState(false);
  // Carries its tone: a refused PutParameter must not read like "the parser now invokes …".
  const [msg, setMsg] = useState<ActionOutcome | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => {
        setModelId(c.modelId);
        setAllowed(c.modelIds ?? []);
        // Absent or null when the console layer is off, in which case there is nothing to offer.
        setConsoleDefault(c.consoleDefaultModelId || null);
        const { endpoint: ep, family: fam } = splitModelId(c.modelId);
        setEndpoint(ep);
        setFamily(fam);
        setLoaded(true);
      })
      .catch((e) => setError(String(e)));
  }, []);

  /** Fill the two controls from the console default; the composed id then equals it exactly. */
  const useConsoleDefault = () => {
    if (!consoleDefault) return;
    const { endpoint: ep, family: fam } = splitModelId(consoleDefault);
    setEndpoint(ep);
    setFamily(fam);
  };

  // Composed from the two controls; deliberately NOT saved as it changes.
  const pending = `${endpoint}.${family}`;
  const pendingAllowed = allowed.length === 0 || allowed.includes(pending);
  const dirty = loaded && pending !== modelId;
  // A stored id outside the presets (a bare foundation-model id, say) still shows, so the page never
  // claims a selection it cannot represent with its buttons.
  const storedIsPreset =
    modelId === null ||
    (MODEL_FAMILIES.some((f) => f.suffix === splitModelId(modelId).family) &&
      MODEL_ENDPOINTS.some((e) => e.value === splitModelId(modelId).endpoint));

  const apply = async () => {
    setBusy(true);
    setMsg(null);
    // Not optimistic: the panel's job is to state which model the parser actually invokes, so it
    // should not claim the new one until the parameter holds it.
    try {
      const saved = await saveConfig(pending);
      setModelId(saved.modelId ?? pending);
      setMsg({
        tone: "success",
        text:
          `The parser now invokes ${pending} on its next run.` +
          (endpoint === "global" ? " The global endpoint may serve requests from outside the US." : ""),
      });
    } catch (e) {
      setMsg({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <header>
        <Eyebrow>Pipeline configuration</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Configuration
        </h1>
      </header>

      <Panel className="rc-rise p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">Parser model</div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              Which model the parsing agent invokes. Read from the SSM parameter on every run, so a
              change applies to the next email with no redeploy. The endpoint is a{" "}
              <strong>data-residency</strong> choice, not a speed one:{" "}
              <span className="rc-mono">global</span> may serve the request from outside the US.
            </p>
            {!isAdmin && (
              <p className="rc-mono mt-2 text-[11.5px] text-[var(--rc-ink-faint)]">
                Changing it requires membership of the admin group; the controls below are read-only.
              </p>
            )}
          </div>

          {error ? (
            <Placeholder kind="error">Failed to load — {error}</Placeholder>
          ) : !loaded ? (
            <Placeholder kind="loading">◆ loading…</Placeholder>
          ) : (
            <div className="flex flex-col items-end gap-2">
              <Choice options={MODEL_FAMILIES.map((f) => ({ value: f.suffix, label: f.label }))} value={family} onChange={setFamily} disabled={busy || !isAdmin} />
              <Choice options={MODEL_ENDPOINTS} value={endpoint} onChange={setEndpoint} disabled={busy || !isAdmin} />
              {/* The resolved id, always visible: the two controls compose into it, so an operator who
                  cannot see the result cannot tell a family change from a residency change. */}
              <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">{pending}</span>
              {isAdmin && dirty && pendingAllowed && (
                <button
                  type="button"
                  onClick={apply}
                  disabled={busy}
                  className="rc-mono rounded border border-[var(--rc-cyan)] bg-[var(--rc-panel-2)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--rc-ink)] disabled:opacity-40"
                >
                  {busy ? "Applying…" : "Apply"}
                </button>
              )}
              {dirty && !pendingAllowed && (
                <span className="rc-mono text-[11px] text-[var(--rc-amber)]">not an accepted combination</span>
              )}
            </div>
          )}
        </div>
        {loaded && modelId === null && (
          <p className="rc-mono mt-3 text-[11px] text-[var(--rc-ink-faint)]">
            No selection recorded — the parser is using its deployed default, {DEFAULT_MODEL_ID}.
          </p>
        )}
        {loaded && !storedIsPreset && (
          <p className="rc-mono mt-3 text-[11px] text-[var(--rc-amber)]">
            The stored id, {modelId}, is not one of the presets above; applying a preset replaces it.
          </p>
        )}
        {loaded && consoleDefault && (
          <div
            className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-[var(--rc-ink-faint)]"
            data-testid="console-default-model"
          >
            <span className="rc-mono">
              Console default: <span className="text-[var(--rc-ink-dim)]">{consoleDefault}</span>
            </span>
            {isAdmin && (
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
        {msg && (
          <Notice tone={msg.tone} className="mt-4 text-[12px]">
            {msg.text}
          </Notice>
        )}
      </Panel>

      <Panel className="rc-rise p-6">
        <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">Where the rules live</div>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
          The parser is shaped by three things, none of them configured here. Skills are markdown
          files under <span className="rc-mono">skills/&lt;name&gt;/SKILL.md</span> in the assets
          bucket, loaded on every run; the parser&rsquo;s system prompt is{" "}
          <span className="rc-mono">prompts/parser-system.md</span> beside them; and situational rules
          are records in the knowledge memory. All three are edited from the{" "}
          <Link href="/pipeline/skills" className="text-[var(--rc-cyan)] hover:underline">
            Skills
          </Link>{" "}
          and{" "}
          <Link href="/pipeline/assistant" className="text-[var(--rc-cyan)] hover:underline">
            Assistant
          </Link>{" "}
          tabs, where each change is reviewed before it reaches the parser.
        </p>
      </Panel>
    </div>
  );
}

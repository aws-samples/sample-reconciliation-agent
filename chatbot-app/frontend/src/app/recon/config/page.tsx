"use client";

import { useEffect, useState } from "react";
import {
  getConfig,
  saveConfig,
  getLambdaSource,
  getHarnessInfo,
  type LambdaSourceFile,
  type HarnessInfo,
} from "@/lib/reconApi";
import { Eyebrow, Panel, Placeholder } from "@/components/recon/ui";
import { SourceViewer } from "@/components/recon/SourceViewer";
import { ContactsPanel } from "@/components/recon/ContactsPanel";
import { TemplatesPanel } from "@/components/recon/TemplatesPanel";
import { WorkflowTypesPanel } from "@/components/recon/WorkflowTypesPanel";
import { MODEL_ENDPOINTS, MODEL_FAMILIES, splitModelId } from "@/lib/models/presets";

type PlatformConfigCommentMode = "required" | "optional" | "disapprove-only";

const COMMENT_MODES: {
  value: PlatformConfigCommentMode;
  label: string;
  hint: string;
}[] = [
  {
    value: "disapprove-only",
    label: "Disapprove only",
    hint: "comment mandatory when disapproving (default)",
  },
  {
    value: "required",
    label: "Required",
    hint: "comment mandatory on approve and disapprove",
  },
  { value: "optional", label: "Optional", hint: "comments never mandatory" },
];

// Config tab: operators toggle the deterministic Tier-1 route and review (read-only) the exact
// Lambda source that runs it. The toggle is backed by SSM; the Tier-1 Lambda reads it per batch.
export default function ConfigPage() {
  const [tier1Enabled, setTier1Enabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Auto-resolve threshold: null = disabled; loaded flag distinguishes "off" from "loading".
  const [threshold, setThreshold] = useState<number | null>(null);
  const [thresholdLoaded, setThresholdLoaded] = useState(false);
  const [thresholdInput, setThresholdInput] = useState("0.85");
  const [autoMsg, setAutoMsg] = useState<string | null>(null);

  const [commentReq, setCommentReq] = useState<string>("disapprove-only");
  const [commentMsg, setCommentMsg] = useState<string | null>(null);

  const [agentBackend, setAgentBackend] = useState<string | null>(null);
  const [backendMsg, setBackendMsg] = useState<string | null>(null);

  // The SAVED model selection, and the family/endpoint the controls currently show. They are separate
  // state because the two controls compose into one id: an operator picking a family has not yet
  // chosen anything until the pair is applied, and showing the composed id before the write is the
  // point — "Opus" plus "Global" is a data-residency change they should see spelled out first.
  // `agentModelId === null` means no selection is recorded and each backend uses its deployed default.
  const [agentModelId, setAgentModelId] = useState<string | null>(null);
  const [modelIdsLoaded, setModelIdsLoaded] = useState(false);
  const [allowedModelIds, setAllowedModelIds] = useState<readonly string[]>([]);
  const [modelFamily, setModelFamily] = useState("anthropic.claude-sonnet-5");
  const [modelEndpoint, setModelEndpoint] = useState("us");
  const [modelMsg, setModelMsg] = useState<string | null>(null);
  const [harnessInfo, setHarnessInfo] = useState<HarnessInfo | null>(null);
  const [harnessErr, setHarnessErr] = useState<string | null>(null);

  const [source, setSource] = useState<LambdaSourceFile[] | null>(null);
  const [srcError, setSrcError] = useState<string | null>(null);

  // Tier-2 Runtime agent source (read-only), lazy-loaded when the Runtime backend is selected.
  const [agentSource, setAgentSource] = useState<LambdaSourceFile[] | null>(
    null,
  );
  const [agentSrcErr, setAgentSrcErr] = useState<string | null>(null);

  // Egress-gateway interceptor source (read-only). Loaded eagerly, not behind a toggle: the
  // interceptor runs on every gateway tool call whatever Tier-1 and the backend are set to.
  const [guardSource, setGuardSource] = useState<LambdaSourceFile[] | null>(
    null,
  );
  const [guardSrcErr, setGuardSrcErr] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((c) => {
        setTier1Enabled(c.tier1Enabled);
        setThreshold(c.autoResolveThreshold);
        if (c.autoResolveThreshold !== null)
          setThresholdInput(c.autoResolveThreshold.toFixed(2));
        setThresholdLoaded(true);
        if (c.commentRequirement) setCommentReq(c.commentRequirement);
        if (c.agentBackend) setAgentBackend(c.agentBackend);
        setAgentModelId(c.agentModelId ?? null);
        setAllowedModelIds(c.agentModelIds ?? []);
        setModelIdsLoaded(true);
        const { endpoint, family } = splitModelId(c.agentModelId ?? null);
        setModelEndpoint(endpoint);
        setModelFamily(family);
      })
      .catch((e) => setError(String(e)));
    getLambdaSource()
      .then((f) => setSource(f))
      .catch((e) => setSrcError(String(e)));
    getLambdaSource("guard")
      .then((f) => setGuardSource(f))
      .catch((e) => setGuardSrcErr(String(e)));
  }, []);

  // Lazy-load the live harness config when the Harness backend is (or becomes) selected.
  useEffect(() => {
    if (agentBackend !== "harness" || harnessInfo || harnessErr) return;
    getHarnessInfo()
      .then(setHarnessInfo)
      .catch((e) => setHarnessErr(e instanceof Error ? e.message : String(e)));
  }, [agentBackend, harnessInfo, harnessErr]);

  // Lazy-load the container agent source when the Runtime backend is (or becomes) selected.
  useEffect(() => {
    if (agentBackend !== "runtime" || agentSource || agentSrcErr) return;
    getLambdaSource("agent")
      .then(setAgentSource)
      .catch((e) => setAgentSrcErr(e instanceof Error ? e.message : String(e)));
  }, [agentBackend, agentSource, agentSrcErr]);

  const saveThreshold = async (next: number | null) => {
    setBusy(true);
    setAutoMsg(null);
    try {
      await saveConfig({ autoResolveThreshold: next });
      setThreshold(next);
      setAutoMsg(
        next === null
          ? "Auto-resolve disabled — every case requires human review."
          : `Auto-resolve enabled — cases with computed confidence ≥ ${(next * 100).toFixed(0)}% resolve unattended.`,
      );
    } catch (e) {
      setAutoMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (next: boolean) => {
    setBusy(true);
    setMsg(null);
    // Optimistic; revert on failure.
    const prev = tier1Enabled;
    setTier1Enabled(next);
    try {
      await saveConfig({ tier1Enabled: next });
      setMsg(
        next
          ? "Deterministic Tier-1 enabled — matching items auto-clear."
          : "Deterministic Tier-1 disabled — every item is escalated to the agent.",
      );
    } catch (e) {
      setTier1Enabled(prev ?? null);
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCommentReq = async (mode: string) => {
    setBusy(true);
    setCommentMsg(null);
    try {
      await saveConfig({
        commentRequirement: mode as PlatformConfigCommentMode,
      });
      setCommentReq(mode);
      setCommentMsg(
        mode === "required"
          ? "Comments are now mandatory on approve AND disapprove."
          : mode === "optional"
            ? "Comments are now optional everywhere."
            : "Comments required only when disapproving (default).",
      );
    } catch (e) {
      setCommentMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveBackend = async (backend: string) => {
    setBusy(true);
    setBackendMsg(null);
    const prev = agentBackend;
    setAgentBackend(backend); // optimistic
    try {
      await saveConfig({ agentBackend: backend as "runtime" | "harness" });
      setBackendMsg(
        backend === "harness"
          ? "Switched to the managed AgentCore Harness — new escalations invoke the harness."
          : "Switched to the container AgentCore Runtime — new escalations invoke the runtime.",
      );
    } catch (e) {
      setAgentBackend(prev);
      setBackendMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  // Composed from the two controls. Deliberately NOT saved as it changes: switching family and
  // endpoint one click at a time would write an intermediate pair nobody chose — and half of those
  // intermediates are a data-residency change.
  const pendingModelId = `${modelEndpoint}.${modelFamily}`;
  // Checked against the ids the SERVER said it accepts, not against the local list. The two are
  // hand-maintained copies, and offering Apply for a pair the PUT would reject with a 400 turns a
  // drifted allowlist into an error the operator sees instead of one the developer does.
  const pendingModelIdAllowed =
    !modelIdsLoaded ||
    allowedModelIds.length === 0 ||
    allowedModelIds.includes(pendingModelId);
  const modelDirty = modelIdsLoaded && pendingModelId !== agentModelId;

  const saveModel = async () => {
    setBusy(true);
    setModelMsg(null);
    // Not optimistic, unlike the backend switch above. There is nothing to be optimistic about: the
    // panel's job here is to state which model is actually being invoked, so it should not claim the
    // new one until the parameter holds it.
    try {
      await saveConfig({ agentModelId: pendingModelId });
      setAgentModelId(pendingModelId);
      setModelMsg(
        `Tier-2 now invokes ${pendingModelId} — picked up by both backends on the next escalation.` +
          (modelEndpoint === "global"
            ? " The global endpoint may serve requests from outside the US."
            : ""),
      );
    } catch (e) {
      setModelMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const BACKENDS = [
    {
      value: "runtime",
      label: "Runtime",
      hint: "container (Strands/Bedrock loop)",
    },
    {
      value: "harness",
      label: "Harness",
      hint: "managed AgentCore Harness",
    },
  ];

  return (
    <div className="space-y-8">
      <header>
        <Eyebrow>Platform configuration</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Configuration
        </h1>
      </header>

      {/* --- Tier-1 toggle --- */}
      <Panel className="rc-rise p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
              Deterministic Tier-1 route
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              When enabled, incoming items are first run through the
              deterministic rules engine — exact/tolerance matches auto-clear
              without the agent. When disabled, Tier-1 is bypassed and{" "}
              <em>every</em> item is escalated to the Tier-2 reconciliation
              agent for review.
            </p>
          </div>

          {error ? (
            <Placeholder kind="error">Failed to load — {error}</Placeholder>
          ) : tier1Enabled === null ? (
            <Placeholder kind="loading">◆ loading…</Placeholder>
          ) : (
            <button
              onClick={() => toggle(!tier1Enabled)}
              disabled={busy}
              role="switch"
              aria-checked={tier1Enabled}
              className="rc-mono flex items-center gap-3 rounded border px-4 py-2 text-[12px] uppercase tracking-[0.12em] disabled:opacity-40"
              style={{
                borderColor: tier1Enabled
                  ? "var(--rc-green)"
                  : "var(--rc-line)",
                color: tier1Enabled ? "var(--rc-green)" : "var(--rc-ink-faint)",
              }}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{
                  background: tier1Enabled
                    ? "var(--rc-green)"
                    : "var(--rc-ink-faint)",
                  boxShadow: tier1Enabled ? "0 0 8px var(--rc-green)" : "none",
                }}
              />
              {tier1Enabled ? "Enabled" : "Disabled"}
            </button>
          )}
        </div>
        {msg && (
          <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">
            {msg}
          </p>
        )}

        {/* Tier-1 Lambda source (read-only) — shown inline only while Tier-1 is enabled.
            Includes classify.py, the rule table that stamps tier1_break_type. */}
        {tier1Enabled && (
          <SourceViewer
            title="Tier-1 Lambda source · read-only"
            files={source}
            error={srcError}
            noun="source"
          />
        )}
      </Panel>

      {/* --- Auto-resolve threshold (straight-through processing) --- */}
      <Panel className="rc-rise p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
              Auto-resolve threshold
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              Cases whose <em>computed</em> confidence meets this threshold take
              the full approve path unattended — email, lesson,{" "}
              <code>RESOLVED</code>. Everything below it stays in the queue for
              human review. That number is <em>evidence completeness</em>: the
              fraction of the matched skill&apos;s required evidence steps whose
              tool call actually returned data. Nothing the model says about its
              own confidence feeds it, so the only way to clear the bar is to
              produce the evidence.
            </p>
          </div>

          {!thresholdLoaded ? (
            <Placeholder kind="loading">◆ loading…</Placeholder>
          ) : (
            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-3">
                <input
                  type="number"
                  min="0.5"
                  max="1"
                  step="0.01"
                  value={thresholdInput}
                  onChange={(e) => setThresholdInput(e.target.value)}
                  className="rc-mono w-24 rounded border border-[var(--rc-line)] bg-[var(--rc-panel-2)] px-3 py-2 text-[13px] text-[var(--rc-ink)]"
                />
                <button
                  onClick={() => {
                    const v = parseFloat(thresholdInput);
                    if (Number.isFinite(v) && v >= 0.5 && v <= 1)
                      saveThreshold(v);
                    else setAutoMsg("Threshold must be between 0.50 and 1.00");
                  }}
                  disabled={busy}
                  className="rc-mono rounded border border-[var(--rc-green)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-green)] hover:bg-[var(--rc-green)] hover:text-[#04120f] disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  onClick={() => saveThreshold(null)}
                  disabled={busy || threshold === null}
                  className="rc-mono rounded border border-[var(--rc-ink-faint)] px-4 py-2 text-[12px] uppercase tracking-[0.12em] text-[var(--rc-ink-dim)] hover:text-[var(--rc-ink)] disabled:opacity-40"
                >
                  Disable
                </button>
              </div>
              <span
                className="rc-mono text-[11px]"
                style={{
                  color:
                    threshold !== null
                      ? "var(--rc-green)"
                      : "var(--rc-ink-faint)",
                }}
              >
                {threshold !== null
                  ? `active · ≥ ${(threshold * 100).toFixed(0)}% auto-resolves`
                  : "disabled · all cases reviewed by a human"}
              </span>
            </div>
          )}
        </div>
        {autoMsg && (
          <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">
            {autoMsg}
          </p>
        )}
      </Panel>

      {/* --- Decision-comment requirement --- */}
      <Panel className="rc-rise p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
              Decision comments
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              Whether an analyst must attach a comment when approving or
              disapproving a proposal. Comments feed the lessons ledger and
              AgentCore Memory, so stricter modes yield better agent recall.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              {COMMENT_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => saveCommentReq(m.value)}
                  disabled={busy}
                  title={m.hint}
                  className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
                  style={{
                    color:
                      commentReq === m.value
                        ? "var(--rc-ink)"
                        : "var(--rc-ink-faint)",
                    background:
                      commentReq === m.value
                        ? "var(--rc-panel-2)"
                        : "transparent",
                    border:
                      commentReq === m.value
                        ? "1px solid var(--rc-cyan)"
                        : "1px solid var(--rc-line)",
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              {COMMENT_MODES.find((m) => m.value === commentReq)?.hint}
            </span>
          </div>
        </div>
        {commentMsg && (
          <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">
            {commentMsg}
          </p>
        )}
      </Panel>

      {/* --- Tier-2 agent backend (runtime ⇄ harness) --- */}
      <Panel className="rc-rise p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
              Tier-2 agent backend
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
              Which backend serves escalated items: the container{" "}
              <strong>Runtime</strong> (hand-rolled Strands/Bedrock loop) or the
              managed AgentCore <strong>Harness</strong> (config-declared).
              Switched live — new invocations pick it up immediately; both share
              the same skills, gateway tools, memory, and confidence gate.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <div className="flex gap-2">
              {BACKENDS.map((b) => (
                <button
                  key={b.value}
                  onClick={() => saveBackend(b.value)}
                  disabled={busy || agentBackend === null}
                  title={b.hint}
                  className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
                  style={{
                    color:
                      agentBackend === b.value
                        ? "var(--rc-ink)"
                        : "var(--rc-ink-faint)",
                    background:
                      agentBackend === b.value
                        ? "var(--rc-panel-2)"
                        : "transparent",
                    border:
                      agentBackend === b.value
                        ? "1px solid var(--rc-cyan)"
                        : "1px solid var(--rc-line)",
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
              {agentBackend === null
                ? "loading…"
                : BACKENDS.find((b) => b.value === agentBackend)?.hint}
            </span>
          </div>
        </div>
        {backendMsg && (
          <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">
            {backendMsg}
          </p>
        )}

        {/* --- Model, inside this panel rather than beside it: it applies to BOTH backends above, and
            an operator comparing two models on one queue is doing the same kind of experiment as one
            comparing the two backends. --- */}
        <div className="mt-6 border-t border-[var(--rc-line)] pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="max-w-xl">
              <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
                Model
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                Which Anthropic model the Tier-2 agent invokes. Read per
                invocation by whichever backend is selected above, so a change
                applies to the next escalation with no redeploy. The endpoint is
                a <strong>data-residency</strong> choice, not a speed one:{" "}
                <span className="rc-mono">global</span> may serve the request
                from outside the US.
              </p>
              {agentBackend === "harness" && (
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
                  A deployed harness config version pins its own model and
                  overrides this selection — deliberately, so a scored
                  configuration in the Evals tab stays reproducible. The{" "}
                  <strong>Model</strong> line below is the one actually in
                  effect.
                </p>
              )}
            </div>
            <div className="flex flex-col items-end gap-2">
              <div className="flex gap-2">
                {MODEL_FAMILIES.map((f) => (
                  <button
                    key={f.suffix}
                    onClick={() => setModelFamily(f.suffix)}
                    disabled={busy || !modelIdsLoaded}
                    title={f.suffix}
                    className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
                    style={{
                      color:
                        modelFamily === f.suffix
                          ? "var(--rc-ink)"
                          : "var(--rc-ink-faint)",
                      background:
                        modelFamily === f.suffix
                          ? "var(--rc-panel-2)"
                          : "transparent",
                      border:
                        modelFamily === f.suffix
                          ? "1px solid var(--rc-cyan)"
                          : "1px solid var(--rc-line)",
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                {MODEL_ENDPOINTS.map((e) => (
                  <button
                    key={e.value}
                    onClick={() => setModelEndpoint(e.value)}
                    disabled={busy || !modelIdsLoaded}
                    title={e.hint}
                    className="rc-mono rounded px-3 py-2 text-[11px] uppercase tracking-[0.08em] disabled:opacity-40"
                    style={{
                      color:
                        modelEndpoint === e.value
                          ? "var(--rc-ink)"
                          : "var(--rc-ink-faint)",
                      background:
                        modelEndpoint === e.value
                          ? "var(--rc-panel-2)"
                          : "transparent",
                      border:
                        modelEndpoint === e.value
                          ? "1px solid var(--rc-cyan)"
                          : "1px solid var(--rc-line)",
                    }}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
              {/* The resolved id, always visible. The two controls compose into it, so an operator who
                  cannot see the result cannot tell a family change from a residency change. */}
              <span className="rc-mono text-[11px] text-[var(--rc-ink-faint)]">
                {!modelIdsLoaded ? "loading…" : pendingModelId}
              </span>
              {modelDirty && pendingModelIdAllowed && (
                <button
                  onClick={saveModel}
                  disabled={busy}
                  className="rc-mono rounded border border-[var(--rc-cyan)] bg-[var(--rc-panel-2)] px-3 py-2 text-[11px] uppercase tracking-[0.08em] text-[var(--rc-ink)] disabled:opacity-40"
                >
                  Apply
                </button>
              )}
              {modelDirty && !pendingModelIdAllowed && (
                <span className="rc-mono text-[11px] text-[var(--rc-amber)]">
                  not an accepted combination
                </span>
              )}
            </div>
          </div>
          {/* No selection recorded is a real state, not a missing value: it means neither backend has
              been told which model to use, so each uses the one it was deployed with. Saying so beats
              naming an id this page cannot actually verify. */}
          {modelIdsLoaded && agentModelId === null && (
            <p className="rc-mono mt-3 text-[11px] text-[var(--rc-ink-faint)]">
              No selection recorded — each backend is using the model it was
              deployed with.
            </p>
          )}
          {modelMsg && (
            <p className="rc-mono mt-4 text-[12px] text-[var(--rc-cyan)]">
              {modelMsg}
            </p>
          )}
        </div>

        {/* Runtime agent source (read-only) — shown when the Runtime backend is selected,
            mirroring the Tier-1 section's inline source viewer. */}
        {agentBackend === "runtime" && (
          <SourceViewer
            title="Runtime agent source · read-only"
            files={agentSource}
            error={agentSrcErr}
            noun="agent source"
          />
        )}

        {/* Live AgentCore Harness config — shown only when the Harness backend is selected. */}
        {agentBackend === "harness" && (
          <div className="mt-6 border-t border-[var(--rc-line)] pt-5">
            <Eyebrow>AgentCore Harness configuration · live</Eyebrow>
            <div className="mt-3">
              {harnessErr ? (
                <Placeholder kind="error">
                  Failed to load harness — {harnessErr}
                </Placeholder>
              ) : !harnessInfo ? (
                <Placeholder kind="loading">◆ loading harness…</Placeholder>
              ) : !harnessInfo.configured ? (
                <Placeholder kind="empty">
                  ◇ no harness provisioned ({harnessInfo.name})
                </Placeholder>
              ) : (
                <dl className="grid grid-cols-[auto,1fr] gap-x-6 gap-y-2 text-[12px]">
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">Name</dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {harnessInfo.name}
                  </dd>
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">Status</dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {harnessInfo.status}
                  </dd>
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">Model</dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {harnessInfo.model}
                  </dd>
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">
                    Max iterations
                  </dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {harnessInfo.maxIterations ?? "—"}
                  </dd>
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">Tools</dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {(harnessInfo.allowedTools ?? []).join(", ") || "—"}
                  </dd>
                  <dt className="rc-mono text-[var(--rc-ink-faint)]">Skills</dt>
                  <dd className="rc-mono text-[var(--rc-ink)]">
                    {(harnessInfo.skills ?? []).length === 0
                      ? "—"
                      : (harnessInfo.skills ?? [])
                          // s3://<bucket>/skills/<name>/ → <name>
                          .map(
                            (u) => u.replace(/\/+$/, "").split("/").pop() || u,
                          )
                          .join(", ")}
                  </dd>
                </dl>
              )}
            </div>
          </div>
        )}
      </Panel>

      {/* --- What may be uploaded, and where each upload goes --- */}
      <WorkflowTypesPanel />

      {/* --- Who may be emailed, and in what words --- */}
      <ContactsPanel />
      <TemplatesPanel />

      {/* --- Egress-gateway write guard (read-only) --- */}
      <Panel className="rc-rise p-6">
        <div className="max-w-2xl">
          <div className="rc-mono text-[15px] font-medium text-[var(--rc-ink)]">
            Gateway write guard
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-[var(--rc-ink-dim)]">
            Every tool call the agent makes passes through this REQUEST
            interceptor on the egress gateway <em>before</em> AgentCore Policy
            sees it. It refuses a ledger write on two grounds no confidence
            threshold can express: <strong>provenance</strong> — the reference
            being written must match the <code>proposed_action</code> persisted
            on the case — and <strong>extraction confidence</strong> — the write
            is refused outright when the IDP extraction behind the case flagged
            any field as low-confidence. Neither is configurable here; this is
            the deployed code, shown so the guarantee is auditable.
          </p>
        </div>
        <SourceViewer
          title="Gateway interceptor source · read-only"
          files={guardSource}
          error={guardSrcErr}
          noun="guard source"
        />
      </Panel>
    </div>
  );
}

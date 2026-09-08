"use client";

import { useEffect, useState, useCallback } from "react";
import { Panel, Eyebrow, Stat, Placeholder } from "@/components/recon/ui";
import {
  getEvalSummary,
  getEvalResults,
  startBatchEval,
  getBatchEval,
  startRecommendation,
  getRecommendation,
  getRecommendationBatch,
  getHarnessConfigs,
  createHarnessConfig,
  deployHarnessConfig,
  setHarnessConfigArchived,
  type EvalSummary,
  type EvalResult,
  type BatchEvalStatus,
  type Recommendation,
  type HarnessConfigVersion,
} from "@/lib/reconApi";
import { lintPromptPolicy } from "@/lib/promptPolicyLint";

// --- Panel 1: Last 7 days summary ---

function SummaryPanel() {
  const [data, setData] = useState<EvalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    getEvalSummary(7)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error)
    return (
      <Panel>
        <Eyebrow>Last 7 Days</Eyebrow>
        <Placeholder>
          Couldn&apos;t load evaluation metrics: {error}. Metrics appear once
          either backend has run scored sessions (CloudWatch Transaction Search
          must be enabled).
        </Placeholder>
      </Panel>
    );

  if (!data)
    return (
      <Panel>
        <Eyebrow>Last 7 Days</Eyebrow>
        <Placeholder>Loading evaluation metrics...</Placeholder>
      </Panel>
    );

  const evaluators = Object.entries(data.series);
  if (evaluators.every(([, s]) => s.averages.length === 0))
    return (
      <Panel>
        <Eyebrow>Last 7 Days</Eyebrow>
        <Placeholder>
          No evaluation data in the last 7 days. The backend is not the gate —
          both the runtime and the harness have their own online evaluation
          config, so sessions on either one are scored. Scores land roughly
          10–15 minutes after a session closes. Note that analyst_agreement
          contributes no average until a lesson exists for the item: it
          abstains, and an abstain publishes a label with no metric datapoint.
        </Placeholder>
      </Panel>
    );

  return (
    <Panel>
      <Eyebrow>Last 7 Days</Eyebrow>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        {evaluators.map(([name, s]) => {
          const avg =
            s.averages.length > 0
              ? (
                  s.averages.reduce((a, b) => a + b, 0) / s.averages.length
                ).toFixed(2)
              : "—";
          const total = s.counts.reduce((a, b) => a + b, 0);
          return (
            <Stat
              key={name}
              label={name.replace("Builtin.", "")}
              value={avg}
              sub={`${total} sessions`}
            />
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">
        Analyst-agreement decisions land after sessions run — the weekly batch
        re-score is the ground-truth pass (online scores skew to abstain until
        then).
      </p>
    </Panel>
  );
}

// --- Panel 2: Batch evaluation ---

function BatchPanel() {
  const [running, setRunning] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [result, setResult] = useState<BatchEvalStatus | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setResult(null);
    try {
      const { batchEvaluationId } = await startBatchEval({
        evaluatorIds: [
          "analyst_agreement",
          "Builtin.GoalSuccessRate",
          "Builtin.Helpfulness",
          "Builtin.Correctness",
        ],
      });
      setBatchId(batchEvaluationId);
      // Poll every 5s
      const poll = setInterval(async () => {
        const s = await getBatchEval(batchEvaluationId);
        if (s.status !== "IN_PROGRESS" && s.status !== "STARTING") {
          clearInterval(poll);
          setResult(s);
          setRunning(false);
        }
      }, 5000);
    } catch {
      setRunning(false);
    }
  }, []);

  return (
    <Panel>
      <Eyebrow>Batch Evaluation</Eyebrow>
      <p className="text-sm text-zinc-400 mb-3">
        Re-score the active backend&apos;s recent sessions against all
        evaluators (including ground-truth analyst-agreement). Approving or
        correcting a case already re-scores that case automatically — use this
        for a full sweep.
      </p>
      <button
        onClick={run}
        disabled={running}
        className="px-3 py-1.5 rounded bg-cyan-700 text-white text-sm disabled:opacity-50"
      >
        {running
          ? "Running..."
          : "Re-run evaluation (via AgentCore Batch Evaluations)"}
      </button>
      {result && (
        <pre className="mt-3 text-xs bg-zinc-900 p-2 rounded overflow-auto max-h-40">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </Panel>
  );
}

// --- Panel 3: Recommendations (AgentCore optimization) ---
// A terminal recommendation status is COMPLETED or FAILED (per the AgentCore API:
// PENDING|IN_PROGRESS|COMPLETED|FAILED|DELETING). A COMPLETED system-prompt recommendation can
// be applied straight into a new managed config version via onApply.

function RecommendationsPanel({
  onApplyPrompt,
}: {
  onApplyPrompt: (prompt: string) => void;
}) {
  const [type, setType] = useState<
    "SYSTEM_PROMPT_RECOMMENDATION" | "TOOL_DESCRIPTION_RECOMMENDATION"
  >("SYSTEM_PROMPT_RECOMMENDATION");
  const [running, setRunning] = useState(false);
  // Which leg of the handshake is in flight — the source batch eval alone takes ~65s, so a bare
  // "Generating…" leaves the user watching a dead button for over a minute.
  const [phase, setPhase] = useState<"BATCH" | "OPTIMIZING" | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setRunning(true);
    setPhase(null);
    setRec(null);
    setError(null);
    // Each poll below is one short request. The long waits live HERE, in the browser, because
    // CloudFront kills any origin request that runs past 60s (see the route's header comment).
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      const started = await startRecommendation({ type });

      let recommendationId = started.recommendationId;
      // Which artifact's prompt is being optimized. The optimizer screens it with prompt-attack
      // protection and rejects prompts that read like an injected role delimiter, so a failure
      // has to say WHICH prompt to go edit — the message alone ("review your system prompt")
      // doesn't distinguish the runtime S3 prompt from a deployed harness config version.
      let promptSource = started.promptSource ?? null;
      if (started.phase === "BATCH") {
        // System prompt: drive the source batch evaluation to a terminal state ourselves.
        if (!started.batchEvaluationId) {
          throw new Error("No batchEvaluationId returned by the service.");
        }
        setPhase("BATCH");
        let arn: string | null = null;
        // 5s cadence, 5 minute ceiling — the observed run is ~65s; anything near the ceiling
        // means the window holds far more sessions than a dev backend produces.
        for (let waited = 0; waited < 300; waited += 5) {
          await sleep(5000);
          const b = await getRecommendationBatch(started.batchEvaluationId);
          if (b.running) continue;
          if (!b.batchEvaluationArn) {
            // FAILED / STOPPED, or a terminal state with no usable source. Say which.
            throw new Error(
              `Source batch evaluation ended ${b.status} — no usable trace source.`,
            );
          }
          arn = b.batchEvaluationArn;
          break;
        }
        if (!arn) {
          throw new Error(
            "Timed out after 5 minutes waiting for the source batch evaluation.",
          );
        }
        const withSource = await startRecommendation({
          type,
          batchEvaluationArn: arn,
        });
        recommendationId = withSource.recommendationId;
        promptSource = withSource.promptSource ?? promptSource;
      }

      if (!recommendationId) {
        throw new Error("No recommendation id returned by the service.");
      }

      // Poll to a TERMINAL status; surface errors instead of silently stopping.
      setPhase("OPTIMIZING");
      for (let waited = 0; waited < 600; waited += 5) {
        await sleep(5000);
        const r = await getRecommendation(recommendationId);
        if (r.status === "COMPLETED" || r.status === "FAILED") {
          setRec(r);
          setRunning(false);
          setPhase(null);
          if (r.status === "FAILED") {
            const why =
              r.errorMessage || r.errorCode || "Recommendation failed.";
            setError(promptSource ? `${why} (prompt: ${promptSource})` : why);
          }
          return;
        }
      }
      throw new Error(
        "Timed out after 10 minutes waiting for the recommendation.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRunning(false);
      setPhase(null);
    }
  }, [type]);

  const buttonLabel = !running
    ? "Generate Recommendation"
    : phase === "BATCH"
      ? "Assembling sessions… (~1 min)"
      : phase === "OPTIMIZING"
        ? "Optimizing…"
        : "Starting…";

  return (
    <Panel>
      <Eyebrow>Recommendations</Eyebrow>
      <p className="text-sm text-zinc-400 mb-3">
        AgentCore optimization analyzes the active backend&apos;s recent agent
        traces and proposes an improved system prompt or tool descriptions.
      </p>
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setType("SYSTEM_PROMPT_RECOMMENDATION")}
          className={`text-xs px-2 py-1 rounded ${type === "SYSTEM_PROMPT_RECOMMENDATION" ? "bg-cyan-800 text-white" : "bg-zinc-800 text-zinc-400"}`}
        >
          System Prompt
        </button>
        <button
          onClick={() => setType("TOOL_DESCRIPTION_RECOMMENDATION")}
          className={`text-xs px-2 py-1 rounded ${type === "TOOL_DESCRIPTION_RECOMMENDATION" ? "bg-cyan-800 text-white" : "bg-zinc-800 text-zinc-400"}`}
        >
          Tool Descriptions
        </button>
      </div>
      <button
        onClick={generate}
        disabled={running}
        className="px-3 py-1.5 rounded bg-cyan-700 text-white text-sm disabled:opacity-50"
      >
        {buttonLabel}
      </button>

      {error && (
        <p className="mt-3 text-xs text-red-400">
          Recommendation error: {error}
        </p>
      )}

      {rec?.recommendedSystemPrompt && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-zinc-500">
            Recommended system prompt{" "}
            {rec.systemPromptExplanation
              ? "· " + rec.systemPromptExplanation
              : ""}
          </div>
          <pre className="text-xs bg-zinc-900 p-2 rounded overflow-auto max-h-60 whitespace-pre-wrap break-words">
            {rec.recommendedSystemPrompt}
          </pre>
          {/* The optimizer's safety pass injects a confirmation policy into every run, whatever
              the baseline said — so this normally fires and needs an edit before deploying. */}
          {rec.policyWarnings && rec.policyWarnings.length > 0 && (
            <div className="text-xs bg-amber-950/60 border border-amber-800 rounded p-2 space-y-1">
              <div className="text-amber-300 font-medium">
                Edit before deploying — conflicts with this platform&apos;s
                autonomy model:
              </div>
              <ul className="list-disc pl-4 text-amber-200/90 space-y-0.5">
                {rec.policyWarnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          <button
            onClick={() => onApplyPrompt(rec.recommendedSystemPrompt as string)}
            className="px-3 py-1.5 rounded bg-violet-700 text-white text-sm"
          >
            Apply to a new config version →
          </button>
        </div>
      )}

      {rec?.recommendedTools && rec.recommendedTools.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs text-zinc-500">
            Recommended tool descriptions
          </div>
          {rec.recommendedTools.map((t) => (
            <div
              key={t.toolName}
              className="text-xs bg-zinc-900 p-2 rounded space-y-1"
            >
              <div className="font-mono text-cyan-400">{t.toolName}</div>
              <div className="text-zinc-300 whitespace-pre-wrap break-words">
                {t.recommendedToolDescription}
              </div>
              {t.explanation && (
                <div className="text-zinc-500">{t.explanation}</div>
              )}
            </div>
          ))}
        </div>
      )}

      {rec &&
        rec.status === "COMPLETED" &&
        !rec.recommendedSystemPrompt &&
        !(rec.recommendedTools && rec.recommendedTools.length) && (
          <p className="mt-3 text-xs text-zinc-500">
            The optimizer completed but returned no changes — usually too few
            traces in the window. Run more agent sessions, then retry.
          </p>
        )}
    </Panel>
  );
}

// --- Panel 4: Config Versions ---
// The create/edit form is HIDDEN by default — it opens only when the user clicks "New version",
// clicks "Edit" on an existing version (seeds the draft from it), or applies a recommendation
// (seedPrompt from the Recommendations panel). This addresses the always-visible-form issue and
// the missing-edit affordance.

function ConfigPanel({
  seedPrompt,
  seedNonce,
}: {
  seedPrompt: string;
  seedNonce: number;
}) {
  const [configs, setConfigs] = useState<HarnessConfigVersion[]>([]);
  const [deployed, setDeployed] = useState<string | null>(null);
  // null = drift undeterminable; false = the shared prompt object was edited after this version was
  // deployed (the Skills tab writes it without moving the pointer), so "LIVE" alone would mislead.
  const [liveMatches, setLiveMatches] = useState<boolean | null>(null);
  const [archivedCount, setArchivedCount] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ prompt: "", comment: "" });
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await getHarnessConfigs(showArchived);
      setConfigs(data.configs);
      setDeployed(data.deployed);
      setLiveMatches(data.liveMatchesDeployed);
      setArchivedCount(data.archivedCount);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [showArchived]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // A recommendation was applied → open the form seeded with the recommended prompt.
  useEffect(() => {
    if (seedNonce > 0 && seedPrompt) {
      setDraft({
        prompt: seedPrompt,
        comment: "From AgentCore system-prompt recommendation",
      });
      setEditing(true);
    }
  }, [seedNonce, seedPrompt]);

  const save = async () => {
    if (!draft.prompt) return;
    setSaving(true);
    try {
      await createHarnessConfig({
        system_prompt: draft.prompt,
        comment: draft.comment,
      });
      setDraft({ prompt: "", comment: "" });
      setEditing(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const editFrom = (c: HarnessConfigVersion) => {
    setDraft({
      prompt: c.system_prompt ?? "",
      comment: `Edited from ${c.version}`,
    });
    setEditing(true);
  };

  // Deploy is not a pointer flip: it writes this version's prompt into the shared prompt object
  // both backends read, so say so before the user confirms — and name any conflict with the
  // platform's autonomy model, since an optimizer-derived version always carries an injected
  // "wait for explicit approval" rule the API refuses to deploy unacknowledged.
  const deploy = async (c: HarnessConfigVersion) => {
    const warnings = lintPromptPolicy(c.system_prompt ?? "");
    const conflicts = warnings.length
      ? `\n\n⚠ This prompt conflicts with how the platform runs:\n` +
        warnings.map((w) => `• ${w}`).join("\n") +
        `\n\nDeploy anyway?`
      : "";
    if (
      !confirm(
        `Deploy config ${c.version}?\n\nThis makes its system prompt live for BOTH Tier-2 backends ` +
          `(runtime and harness) by writing it to the shared prompt object.${conflicts}`,
      )
    )
      return;
    try {
      // acknowledgeWarnings only after the confirm above listed the specific conflicts.
      await deployHarnessConfig(c.version, warnings.length > 0);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Archive is a soft flag — the document stays in S3 as the record of what ran, and the API
  // refuses to archive the deployed version.
  const setArchived = async (c: HarnessConfigVersion, archived: boolean) => {
    if (
      archived &&
      !confirm(
        `Archive config ${c.version}?\n\nIt is hidden from this list but not deleted — ` +
          `tick “Show archived” to bring it back.`,
      )
    )
      return;
    try {
      await setHarnessConfigArchived(c.version, archived);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Panel>
      <div className="flex items-center justify-between">
        <Eyebrow>Config Versions</Eyebrow>
        <div className="flex items-center gap-3">
          {archivedCount > 0 && (
            <label className="flex items-center gap-1 text-xs text-zinc-500">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="accent-cyan-500"
              />
              Show archived ({archivedCount})
            </label>
          )}
          {!editing && (
            <button
              onClick={() => {
                setDraft({ prompt: "", comment: "" });
                setEditing(true);
              }}
              className="text-xs text-cyan-400 hover:underline"
            >
              + New version
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      {/* Drift: the Skills tab (Skills → System Prompt) writes the shared prompt object directly
          and never moves the pointer, so the deployed version can stop being the live text. Say so
          rather than leaving a green LIVE badge to imply otherwise. */}
      {liveMatches === false && deployed && (
        <p className="mt-2 text-xs text-amber-400">
          The live prompt no longer matches {deployed} — it was edited in Skills
          → System Prompt after that deploy. Both backends run the edited text;
          save it as a new version to make the record match.
        </p>
      )}

      {configs.length === 0 ? (
        <Placeholder>
          No config versions yet. Generate a recommendation and apply it, or
          click “New version”, to create the first managed prompt/model
          override.
        </Placeholder>
      ) : (
        <div className="overflow-auto max-h-48 my-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-zinc-500 border-b border-zinc-800">
                <th className="text-left py-1">Version</th>
                <th className="text-left py-1">Comment</th>
                <th className="text-left py-1">Created</th>
                <th className="text-left py-1">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr
                  key={c.version}
                  className={`border-b border-zinc-900 ${c.archived ? "opacity-50" : ""}`}
                >
                  <td className="py-1 font-mono">{c.version}</td>
                  <td className="py-1 text-zinc-400">{c.comment || "—"}</td>
                  <td className="py-1 text-zinc-500">
                    {c.created_at?.slice(0, 10)}
                  </td>
                  <td className="py-1">
                    {c.version === deployed ? (
                      liveMatches === false ? (
                        <span
                          className="text-amber-400 font-medium"
                          title="Deployed, but the shared prompt object was edited in the Skills tab afterwards — the live text is not this version's."
                        >
                          LIVE · edited since
                        </span>
                      ) : liveMatches === null ? (
                        <span
                          className="text-green-400 font-medium"
                          title="Deployed. Could not read the shared prompt object to confirm the live text matches."
                        >
                          LIVE ?
                        </span>
                      ) : (
                        <span className="text-green-400 font-medium">LIVE</span>
                      )
                    ) : c.archived ? (
                      <span className="text-zinc-600">archived</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="py-1 space-x-2 text-right">
                    <button
                      onClick={() => editFrom(c)}
                      className="text-xs text-zinc-400 hover:underline"
                    >
                      Edit
                    </button>
                    {c.version !== deployed && (
                      <button
                        onClick={() => deploy(c)}
                        className="text-xs text-cyan-400 hover:underline"
                      >
                        Deploy
                      </button>
                    )}
                    {/* No archive control on the deployed version: the API refuses it (it is the
                        rollback target and the drift baseline). */}
                    {c.version !== deployed &&
                      (c.archived ? (
                        <button
                          onClick={() => setArchived(c, false)}
                          className="text-xs text-zinc-400 hover:underline"
                        >
                          Unarchive
                        </button>
                      ) : (
                        <button
                          onClick={() => setArchived(c, true)}
                          className="text-xs text-zinc-500 hover:underline"
                        >
                          Archive
                        </button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="border-t border-zinc-800 pt-3 space-y-2">
          <input
            placeholder="Comment (optional)"
            value={draft.comment}
            onChange={(e) =>
              setDraft((d) => ({ ...d, comment: e.target.value }))
            }
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
          />
          <textarea
            placeholder="System prompt…"
            value={draft.prompt}
            onChange={(e) =>
              setDraft((d) => ({ ...d, prompt: e.target.value }))
            }
            rows={6}
            className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm font-mono"
          />
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={!draft.prompt || saving}
              className="px-3 py-1.5 rounded bg-violet-700 text-white text-sm disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save as New Version"}
            </button>
            <button
              onClick={() => {
                setEditing(false);
                setDraft({ prompt: "", comment: "" });
              }}
              className="px-3 py-1.5 rounded bg-zinc-800 text-zinc-300 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

// --- Page ---

export default function EvalsPage() {
  // Applying a recommended prompt seeds the Config panel's create form (nonce forces the effect
  // to re-run even if the same prompt text is applied twice).
  const [seedPrompt, setSeedPrompt] = useState("");
  const [seedNonce, setSeedNonce] = useState(0);
  const applyPrompt = useCallback((prompt: string) => {
    setSeedPrompt(prompt);
    setSeedNonce((n) => n + 1);
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Agent Evaluations</h1>
      <SummaryPanel />
      <div className="grid md:grid-cols-2 gap-6">
        <BatchPanel />
        <RecommendationsPanel onApplyPrompt={applyPrompt} />
      </div>
      <ConfigPanel seedPrompt={seedPrompt} seedNonce={seedNonce} />
    </div>
  );
}

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getConfig, saveConfig } from "@/lib/pipelineApi";
import { useAppSubject } from "@/hooks/useAppSubject";
import { Eyebrow, Notice, Panel, type ActionOutcome } from "@/components/app-ui/ui";
import { ModelSelectPanel } from "@/components/app-ui/ModelSelectPanel";
import { DEFAULT_MODEL_ID, splitModelId } from "@/lib/models/presets";

export default function ConfigPage() {
  const { isAdmin } = useAppSubject("pipeline");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The SAVED selection; the family/endpoint controls and the pending pair they compose live in the
  // shared `ModelSelectPanel`, which hands back the composed id on Apply.
  const [modelId, setModelId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<readonly string[]>([]);
  // The console-wide default model, when the console has one (`/console/settings`, Defaults). The panel
  // offers it as a one-click fill for the controls; Apply still writes THIS app's parameter, because the
  // parser reads that parameter and nothing else.
  const [consoleDefault, setConsoleDefault] = useState<string | null>(null);
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
        setLoaded(true);
      })
      .catch((e) => setError(String(e)));
  }, []);

  /** Apply the id the panel composed. Called by the panel only for a dirty, server-accepted pair. */
  const apply = async (pending: string) => {
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
          (splitModelId(pending).endpoint === "global"
            ? " The global endpoint may serve requests from outside the US."
            : ""),
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
        <ModelSelectPanel
          title="Parser model"
          value={modelId}
          loaded={loaded}
          allowed={allowed}
          consoleDefault={consoleDefault}
          deployedDefault={`the parser is using its deployed default, ${DEFAULT_MODEL_ID}.`}
          onApply={apply}
          readOnly={!isAdmin}
          busy={busy}
          error={error}
          description={
            <>
              Which model the parsing agent invokes. Read from the SSM parameter on every run, so a
              change applies to the next email with no redeploy. The endpoint is a{" "}
              <strong>data-residency</strong> choice, not a speed one:{" "}
              <span className="rc-mono">global</span> may serve the request from outside the US.
              {!isAdmin && (
                <p className="rc-mono mt-2 text-[11.5px] text-[var(--rc-ink-faint)]">
                  Changing it requires membership of the admin group; the controls below are read-only.
                </p>
              )}
            </>
          }
        />
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

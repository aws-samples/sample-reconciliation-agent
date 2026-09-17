"use client";

import { getParserPrompt, saveParserPrompt } from "@/lib/pipelineApi";
import { useAppSubject } from "@/hooks/useAppSubject";
import { PromptEditorPage } from "@/components/app-ui/PromptEditorPage";

// The parsing agent's system prompt: how it approaches an email before any skill is applied. Stored
// in S3 and read on every run, so an edit applies without a redeploy. The shared prompt editor with
// the pipeline's text: admins edit, everyone else reads, and Save waits for a change.
export default function ParserPromptPage() {
  const { isAdmin } = useAppSubject("pipeline");
  return (
    <PromptEditorPage
      load={getParserPrompt}
      save={saveParserPrompt}
      backHref="/pipeline/skills"
      path="prompts/parser-system.md"
      eyebrow={
        isAdmin
          ? "Parsing agent · system prompt · applies on the next run"
          : "Parsing agent · system prompt · read-only"
      }
      title="Parser prompt"
      savedMessage="Saved — the next parse uses this prompt."
      readOnly={!isAdmin}
      disableSaveWhenClean
      textareaLabel="Parser system prompt"
      placeholder="Describe how the parsing agent should read a deal email…"
      loadingLabel="◆ loading the parser prompt…"
      heightClass="h-[60vh] min-h-[320px]"
    />
  );
}

"use client";

import { getSystemPrompt, saveSystemPrompt } from "@/lib/reconApi";
import { PromptEditorPage } from "@/components/app-ui/PromptEditorPage";

// System-prompt editor: defines the overall reconciliation workflow the agent follows. Stored in
// S3, read live by the agent (~60s), so edits apply without a redeploy.
//
// This is the SHARED policy core — both Tier-2 backends read this one object (the harness appends
// its own calling contract on top). Saying so in the UI matters: the previous split-per-backend
// layout let an edit here apply to whichever backend happened to be active and silently not the
// other.
//
// The page is the shared prompt editor with recon's text. No admin gate and no "nothing changed" gate:
// every viewer the proxy admits may save, whatever is in the box, as the route behind it allows
// (docs/shared-spine-proposal.md §8a, option 1).
export default function SystemPromptPage() {
  return (
    <PromptEditorPage
      load={getSystemPrompt}
      save={saveSystemPrompt}
      backHref="/recon/skills"
      eyebrow="Overall workflow · shared by both Tier-2 backends · applies live (~60s)"
      title="System Prompt"
      savedMessage="Saved — applies to both Tier-2 backends within ~60s."
      placeholder="Define the overall reconciliation workflow the agent should follow…"
      loadingLabel="◆ loading system prompt…"
    />
  );
}

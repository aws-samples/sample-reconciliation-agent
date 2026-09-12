"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePipelineSubject } from "@/hooks/usePipelineSubject";
import { ChatPanel } from "@/components/pipeline/ChatPanel";
import { MemoryManagerPanel } from "@/components/pipeline/MemoryManagerPanel";
import { Eyebrow, Placeholder } from "@/components/app-ui/ui";

// The learning-loop tab: the conversation on the left, what it has taught the parser on the right.
// `?deal=` / `?email=` arrive from the "Ask the assistant about this" buttons and are sent as context
// with every turn, so the assistant starts by reading the right record rather than asking which.

function AssistantContent() {
  const params = useSearchParams();
  const dealId = params.get("deal");
  const emailId = params.get("email");
  const { isAdmin } = usePipelineSubject();
  // Bumped after every completed assistant turn so the memory panel picks up a `save_memory`.
  const [turns, setTurns] = useState(0);

  const context = useMemo(
    () =>
      dealId || emailId
        ? { deal_id: dealId ?? undefined, email_id: emailId ?? undefined }
        : undefined,
    [dealId, emailId],
  );

  return (
    <div className="space-y-6">
      <header>
        <Eyebrow>Diagnose · propose a skill change · save a memory</Eyebrow>
        <h1 className="rc-display mt-2 text-[34px] font-black leading-none text-[var(--rc-ink)]">
          Assistant
        </h1>
        <p className="mt-3 max-w-3xl text-[12.5px] leading-relaxed text-[var(--rc-ink-dim)]">
          Two tiers of learning. A rule that applies to every deal becomes a{" "}
          <span className="text-[var(--rc-ink)]">skill proposal</span>, reviewed on the Skills tab
          before it changes the parser. A rule conditioned on a counterparty, a sector or a source
          format is saved to <span className="text-[var(--rc-ink)]">memory</span>, which the parser
          recalls when the next similar email arrives.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <ChatPanel context={context} onTurnComplete={() => setTurns((n) => n + 1)} />
        <MemoryManagerPanel isAdmin={isAdmin} refreshToken={turns} />
      </div>
    </div>
  );
}

export default function AssistantPage() {
  return (
    <Suspense fallback={<Placeholder kind="loading">◆ loading the assistant…</Placeholder>}>
      <AssistantContent />
    </Suspense>
  );
}

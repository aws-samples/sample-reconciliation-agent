"use client";

import type { Tier1Detail } from "@/lib/reconApi";
import { Eyebrow, Panel } from "@/components/recon/ui";

// What the deterministic tier concluded before the agent ran. The class is a HINT — the agent
// classifies independently and may disagree, so this panel says "suggested" and never implies the
// case's own class_id should match it. `agentClass` is passed only to explain a divergence when one
// exists; a mismatch is the system working as designed, not a contradiction.
export function Tier1RoutingPanel({
  tier1,
  agentClass,
}: {
  tier1: Tier1Detail;
  agentClass?: string | null;
}) {
  const diverged =
    !!tier1.tier1_break_type &&
    !!agentClass &&
    tier1.tier1_break_type !== agentClass;

  return (
    <Panel className="rc-rise space-y-3 p-5">
      <Eyebrow>Tier-1 Deterministic Classification</Eyebrow>
      <dl className="rc-mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-[var(--rc-ink-faint)]">Escalated because</dt>
        <dd className="text-[var(--rc-ink)]">
          {tier1.tier1_escalation_reason ?? "—"}
        </dd>
        <dt className="text-[var(--rc-ink-faint)]">Tier-1 suggested</dt>
        <dd className="text-[var(--rc-ink)]">
          {tier1.tier1_break_type ??
            "no rule matched — the agent classified from scratch"}
        </dd>
      </dl>
      {diverged && (
        <p className="rc-mono text-[11px] leading-relaxed text-[var(--rc-ink-dim)]">
          The agent classified this as{" "}
          <span className="text-[var(--rc-ink)]">{agentClass}</span> instead.
          Tier-1&apos;s value is a hint the agent is free to reject, so a
          difference here is expected behaviour, not a conflict.
        </p>
      )}
    </Panel>
  );
}

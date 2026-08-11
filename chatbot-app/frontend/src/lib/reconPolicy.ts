// Config-tab → AgentCore Policy: rewrite the confidence gate's Cedar policies when an admin
// changes the threshold. The threshold is enforced by Policy on the egress gateway, so editing
// it means updating the Cedar statements (the SSM param remains an app-level hint). The Cedar
// statement shape MUST match what Terraform seeded (same gateway ARN + {target}___{tool} action
// names) so the update replaces the same rule.
//
// This module is deliberately free of the AWS SDK import: the control-plane ops are injected
// (see PolicyOps) so the pure Cedar/validation logic is unit-testable without the dependency.
// The route constructs the real client.

// The write-class tool gated on confidence, keyed by its Terraform policy name. (The Microsoft
// Graph email ops are permitted unconditionally — the OpenAPI send op has no confidence param —
// so only set_draw_status is confidence-gated.)
export const GATED_ACTIONS: Record<string, string> = {
  recon_write_gate: "set-draw-status___set_draw_status",
};

/**
 * Build the Cedar statement gating a tool on the confidence input.
 * Mirrors the Terraform-seeded statement EXACTLY (unconstrained principal, action pinned to the
 * gateway-prefixed tool, resource pinned to the egress gateway ARN) so the Config-tab rewrite
 * validates identically. The gateway types `context.input.confidence` as a Cedar DECIMAL (the tool
 * schema declares it a number), so we must (a) guard the optional attribute with `has`, and
 * (b) compare via the `decimal` extension — a bare `>= <Long>` fails Cedar validation. The agent
 * passes confidence as an integer percent [0..100]; `decimal("<pct>.0")` is the same scale.
 */
export function buildGatedCedar(
  action: string,
  gatewayArn: string,
  threshold: number,
): string {
  const pct = Math.round(threshold * 100);
  return (
    `permit(principal, action == AgentCore::Action::"${action}", ` +
    `resource == AgentCore::Gateway::"${gatewayArn}") ` +
    `when { context.input has confidence && context.input.confidence.greaterThanOrEqual(decimal("${pct}.0")) };`
  );
}

/** Validate the threshold is a number in [0,1]; throw otherwise. */
export function assertValidThreshold(t: unknown): asserts t is number {
  if (typeof t !== "number" || Number.isNaN(t) || t < 0 || t > 1) {
    throw new Error("confidence threshold must be a number in [0, 1]");
  }
}

// Minimal control-plane ops the update needs — injected so this module has no SDK import.
// Field names match the AgentCore SDK outputs (policyEngines / policies), typed loosely so the
// route can pass `client.send(...)` results directly.
export interface PolicyOps {
  listPolicyEngines(): Promise<{
    policyEngines?: { name?: string; policyEngineId?: string }[];
  }>;
  listPolicies(
    engineId: string,
  ): Promise<{ policies?: { name?: string; policyId?: string }[] }>;
  updatePolicy(
    engineId: string,
    policyId: string,
    statement: string,
  ): Promise<void>;
}

/**
 * Rewrite both gated Cedar policies to enforce a new confidence threshold. Resolves the engine +
 * policies by name via the injected ops, then updates each statement. Throws on any failure so
 * the caller surfaces it — the policy is the enforcement point, so a silent failure would leave
 * the gate stale.
 */
export async function updateConfidenceThreshold(
  threshold: number,
  ops: PolicyOps,
  { engineName, gatewayArn }: { engineName: string; gatewayArn: string },
): Promise<void> {
  assertValidThreshold(threshold);
  if (!engineName || !gatewayArn) {
    throw new Error(
      "policy engine name and gateway ARN are required to edit the policy gate",
    );
  }
  const engines = await ops.listPolicyEngines();
  const engine = (engines.policyEngines ?? []).find(
    (e) => e.name === engineName,
  );
  if (!engine?.policyEngineId)
    throw new Error(`policy engine ${engineName} not found`);

  const policies = await ops.listPolicies(engine.policyEngineId);
  for (const [policyName, action] of Object.entries(GATED_ACTIONS)) {
    const p = (policies.policies ?? []).find((x) => x.name === policyName);
    if (!p?.policyId) continue; // engine seeded by TF; skip a gate that's absent
    await ops.updatePolicy(
      engine.policyEngineId,
      p.policyId,
      buildGatedCedar(action, gatewayArn, threshold),
    );
  }
}

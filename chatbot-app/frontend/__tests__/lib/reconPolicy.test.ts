import { describe, it, expect } from "vitest";
import {
  buildGatedCedar,
  assertValidThreshold,
  GATED_ACTIONS,
} from "@/lib/reconPolicy";

describe("reconPolicy", () => {
  it("builds a Cedar statement gating a tool on context.input.confidence", () => {
    const s = buildGatedCedar(
      "set-draw-status___set_draw_status",
      "arn:aws:bedrock-agentcore:us-east-1:123:gateway/recon-dev-gateway-abc",
      0.95,
    );
    expect(s).toContain(
      'action == AgentCore::Action::"set-draw-status___set_draw_status"',
    );
    expect(s).toContain(
      'resource == AgentCore::Gateway::"arn:aws:bedrock-agentcore:us-east-1:123:gateway/recon-dev-gateway-abc"',
    );
    expect(s).toContain("context.input has confidence");
    expect(s).toContain(
      'context.input.confidence.greaterThanOrEqual(decimal("95.0"))',
    );
    expect(s.trim().endsWith("};")).toBe(true);
  });

  it("gates only the set_draw_status write (email ops are unconditional)", () => {
    expect(GATED_ACTIONS.recon_write_gate).toBe(
      "set-draw-status___set_draw_status",
    );
    // Email send/read now route through the microsoft-graph OpenAPI target and are permitted
    // unconditionally, so there is no email confidence gate.
    expect(GATED_ACTIONS.recon_email_gate).toBeUndefined();
    expect(Object.keys(GATED_ACTIONS)).toEqual(["recon_write_gate"]);
  });

  it("accepts a threshold in [0,1] and rejects anything else", () => {
    expect(() => assertValidThreshold(0.9)).not.toThrow();
    expect(() => assertValidThreshold(0)).not.toThrow();
    expect(() => assertValidThreshold(1)).not.toThrow();
    expect(() => assertValidThreshold(1.5)).toThrow();
    expect(() => assertValidThreshold(-0.1)).toThrow();
    expect(() => assertValidThreshold("0.9" as unknown)).toThrow();
  });
});

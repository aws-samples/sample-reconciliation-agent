/**
 * The model presets both apps' Config tabs and the console's Defaults section share.
 *
 * The one behaviour with two right answers is what an id with no usable selection decomposes into:
 * the app tabs want the deployed default (so the controls show what actually runs), the console's
 * free-text field wants blanks (so a preset it does not match is not lit up). Both are pinned.
 */
import { describe, expect, it } from "vitest";

import { AGENT_MODEL_IDS } from "@/lib/server/agentModels";
import {
  DEFAULT_MODEL_ID,
  MODEL_ENDPOINTS,
  MODEL_FAMILIES,
  composeModelId,
  splitModelId,
} from "@/lib/models/presets";

describe("splitModelId", () => {
  it("splits at the first dot and composes back to the same id", () => {
    expect(splitModelId("global.anthropic.claude-opus-5")).toEqual({
      endpoint: "global",
      family: "anthropic.claude-opus-5",
    });
    expect(composeModelId("us", "anthropic.claude-sonnet-5")).toBe(
      "us.anthropic.claude-sonnet-5",
    );
  });

  it("decomposes the deployed default for null, empty and dotless ids by default", () => {
    const seed = { endpoint: "us", family: "anthropic.claude-sonnet-5" };
    expect(splitModelId(null)).toEqual(seed);
    expect(splitModelId(undefined)).toEqual(seed);
    expect(splitModelId("")).toEqual(seed);
    expect(splitModelId("nodots")).toEqual(seed);
    expect(composeModelId(seed.endpoint, seed.family)).toBe(DEFAULT_MODEL_ID);
  });

  it("yields blanks instead when asked to, so a free-text id lights up no preset", () => {
    expect(splitModelId("nodots", null)).toEqual({ endpoint: "", family: "" });
    expect(splitModelId("", null)).toEqual({ endpoint: "", family: "" });
    expect(splitModelId("global.anthropic.claude-opus-5", null)).toEqual({
      endpoint: "global",
      family: "anthropic.claude-opus-5",
    });
  });
});

describe("presets against the allowlist", () => {
  it("every composed preset is an id the config routes accept, and vice versa", () => {
    const composed = MODEL_ENDPOINTS.flatMap((e) =>
      MODEL_FAMILIES.map((f) => composeModelId(e.value, f.suffix)),
    );
    expect([...composed].sort()).toEqual([...AGENT_MODEL_IDS].sort());
  });
});

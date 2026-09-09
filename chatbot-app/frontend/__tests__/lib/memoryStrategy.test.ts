import { describe, expect, it } from "vitest";

import { toStrategyInfo } from "@/lib/memoryStrategy";

/** The live recon strategy: CUSTOM with a semantic extraction override and no consolidation override. */
const SEMANTIC_OVERRIDE = {
  strategyId: "str-abc",
  name: "lessons_learned",
  description: "Generalizable lessons derived from analyst decisions.",
  type: "CUSTOM",
  status: "ACTIVE",
  namespaces: ["reconciliation/lessons/{actorId}"],
  configuration: {
    type: "SEMANTIC_OVERRIDE",
    extraction: {
      customExtractionConfiguration: {
        semanticExtractionOverride: {
          appendToPrompt: "You are a long-term memory extraction agent…",
          modelId: "us.anthropic.claude-sonnet-5",
        },
      },
    },
  },
};

describe("toStrategyInfo", () => {
  it("projects a semantic extraction override", () => {
    const info = toStrategyInfo(SEMANTIC_OVERRIDE);
    expect(info).toMatchObject({
      id: "str-abc",
      name: "lessons_learned",
      type: "CUSTOM",
      configurationType: "SEMANTIC_OVERRIDE",
      status: "ACTIVE",
      namespaces: ["reconciliation/lessons/{actorId}"],
    });
    expect(info.extraction).toEqual({
      kind: "semanticExtractionOverride",
      modelId: "us.anthropic.claude-sonnet-5",
      appendToPrompt: "You are a long-term memory extraction agent…",
    });
  });

  it("leaves consolidation null when only extraction is overridden", () => {
    // Deliberate in the recon strategy: if extraction returns [], nothing reaches consolidation.
    expect(toStrategyInfo(SEMANTIC_OVERRIDE).consolidation).toBeNull();
  });

  it("reads a user-preference override from its own union key", () => {
    const info = toStrategyInfo({
      ...SEMANTIC_OVERRIDE,
      configuration: {
        type: "USER_PREFERENCE_OVERRIDE",
        extraction: {
          customExtractionConfiguration: {
            userPreferenceExtractionOverride: {
              appendToPrompt: "prefs",
              modelId: "m",
            },
          },
        },
      },
    });
    expect(info.extraction).toEqual({
      kind: "userPreferenceExtractionOverride",
      modelId: "m",
      appendToPrompt: "prefs",
    });
  });

  it("reads a consolidation override", () => {
    const info = toStrategyInfo({
      ...SEMANTIC_OVERRIDE,
      configuration: {
        type: "SEMANTIC_OVERRIDE",
        consolidation: {
          customConsolidationConfiguration: {
            semanticConsolidationOverride: {
              appendToPrompt: "merge rules",
              modelId: "m2",
            },
          },
        },
      },
    });
    expect(info.consolidation?.appendToPrompt).toBe("merge rules");
    expect(info.extraction).toBeNull();
  });

  it("renders a built-in strategy with no configuration as having no overrides", () => {
    const info = toStrategyInfo({
      strategyId: "str-builtin",
      name: "lessons_learned",
      type: "SEMANTIC",
      status: "ACTIVE",
      namespaces: ["reconciliation/lessons/{actorId}"],
    });
    expect(info.configurationType).toBeNull();
    expect(info.extraction).toBeNull();
    expect(info.consolidation).toBeNull();
    expect(info.type).toBe("SEMANTIC");
  });

  it("falls back to namespaceTemplates when namespaces is absent", () => {
    // `namespaces` is deprecated in favour of `namespaceTemplates`; the panel must survive the switch.
    const info = toStrategyInfo({
      ...SEMANTIC_OVERRIDE,
      namespaces: [],
      namespaceTemplates: ["reconciliation/lessons/{actorId}"],
    });
    expect(info.namespaces).toEqual(["reconciliation/lessons/{actorId}"]);
  });

  it("treats an override with no prompt as absent rather than blank", () => {
    const info = toStrategyInfo({
      ...SEMANTIC_OVERRIDE,
      configuration: {
        type: "SEMANTIC_OVERRIDE",
        extraction: {
          customExtractionConfiguration: {
            semanticExtractionOverride: { appendToPrompt: "", modelId: "m" },
          },
        },
      },
    });
    expect(info.extraction).toBeNull();
  });

  it("survives a strategy stripped of every optional field", () => {
    const info = toStrategyInfo({});
    expect(info).toMatchObject({
      id: "",
      name: "",
      description: null,
      type: "—",
      configurationType: null,
      status: "—",
      namespaces: [],
      extraction: null,
      consolidation: null,
    });
  });
});

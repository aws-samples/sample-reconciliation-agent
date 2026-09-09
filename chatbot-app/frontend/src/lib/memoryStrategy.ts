// Flattens an AgentCore Memory strategy (GetMemory → memory.strategies[]) into the shape the
// Lessons tab's read-only strategy panel renders.
//
// Why this is a module rather than inline in the route: the extraction/consolidation configs are
// SDK UNIONS — "only one key present" — and which key that is depends on the override kind
// (semantic / user-preference / episodic). Probing them belongs in one tested place, not spread
// across a handler. A built-in strategy carries no `configuration` at all; that is a normal state
// to render, not a failure.

/** One overridden phase of a strategy: which override kind, the model, and the live prompt. */
export interface MemoryStrategyOverride {
  /** The union key that was present, e.g. `semanticExtractionOverride`. */
  kind: string;
  modelId: string;
  /**
   * The live prompt. Named after the API field, which is misleading on purpose-of-record: this
   * REPLACES the built-in instructions rather than appending to them.
   */
  appendToPrompt: string;
}

/** A strategy projected for display. Every field is safe to render directly. */
export interface MemoryStrategyInfo {
  id: string;
  name: string;
  description: string | null;
  /** SEMANTIC | SUMMARIZATION | USER_PREFERENCE | CUSTOM | EPISODIC */
  type: string;
  /** SEMANTIC_OVERRIDE | SUMMARY_OVERRIDE | … , or null for a built-in strategy. */
  configurationType: string | null;
  status: string;
  namespaces: string[];
  extraction: MemoryStrategyOverride | null;
  consolidation: MemoryStrategyOverride | null;
}

/** Response shape of `GET /api/recon/memory/strategy`. */
export interface MemoryStrategyResponse {
  /** False when RECON_MEMORY_ID is unset — the same feature-gate contract the records route uses. */
  configured: boolean;
  memoryStatus: string | null;
  strategies: MemoryStrategyInfo[];
}

// The union member names, per phase. Listed rather than pattern-matched on a suffix so an override
// kind the API adds later is reported as absent instead of being half-read.
const EXTRACTION_KEYS = [
  "semanticExtractionOverride",
  "userPreferenceExtractionOverride",
  "episodicExtractionOverride",
] as const;

const CONSOLIDATION_KEYS = [
  "semanticConsolidationOverride",
  "summaryConsolidationOverride",
  "userPreferenceConsolidationOverride",
  "episodicConsolidationOverride",
] as const;

// The SDK types these as deep optional unions; the panel only needs three leaves out of them, and
// typing the full tree here would duplicate the SDK's models for no gain.
/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Read whichever override key is present on one phase of a strategy configuration.
 *
 * @param phaseConfig the `extraction` or `consolidation` object from `configuration`.
 * @param customKey the wrapper key inside it (`customExtractionConfiguration` or
 *   `customConsolidationConfiguration`).
 * @param unionKeys the override member names to probe, in order.
 * @returns the override, or null when the phase is absent or carries no recognised member.
 */
export function overrideOf(
  phaseConfig: any,
  customKey: string,
  unionKeys: readonly string[],
): MemoryStrategyOverride | null {
  const custom = phaseConfig?.[customKey];
  if (!custom) return null;
  for (const key of unionKeys) {
    const override = custom[key];
    // A present-but-empty member is treated as absent: without a prompt there is nothing to show,
    // and rendering an empty <pre> would read as "the prompt is blank".
    if (override?.appendToPrompt) {
      return {
        kind: key,
        modelId: override.modelId ?? "—",
        appendToPrompt: override.appendToPrompt,
      };
    }
  }
  return null;
}

/**
 * Flatten one SDK strategy into the panel's shape.
 *
 * @param raw one entry of `GetMemory`'s `memory.strategies`.
 * @returns the projected strategy.
 */
export function toStrategyInfo(raw: any): MemoryStrategyInfo {
  const config = raw?.configuration;
  return {
    id: raw?.strategyId ?? "",
    name: raw?.name ?? "",
    description: raw?.description ?? null,
    type: raw?.type ?? "—",
    configurationType: config?.type ?? null,
    status: raw?.status ?? "—",
    // `namespaces` is deprecated in favour of `namespaceTemplates`; read both so the panel keeps
    // working through the transition, preferring whichever the service actually populated.
    namespaces: raw?.namespaces?.length
      ? raw.namespaces
      : (raw?.namespaceTemplates ?? []),
    extraction: overrideOf(
      config?.extraction,
      "customExtractionConfiguration",
      EXTRACTION_KEYS,
    ),
    consolidation: overrideOf(
      config?.consolidation,
      "customConsolidationConfiguration",
      CONSOLIDATION_KEYS,
    ),
  };
}

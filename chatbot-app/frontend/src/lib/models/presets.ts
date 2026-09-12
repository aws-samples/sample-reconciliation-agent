/**
 * The model presets the apps' Config tabs and the console's Defaults section offer, in one
 * family-plus-endpoint pattern.
 *
 * A model id is one family plus one endpoint, composed rather than listed: the two are independent
 * choices with different consequences, and a flat list of six ids invites reading `global.` as a
 * capability tier. The hints are the family's own profile id — factual, and the string that appears in
 * traces and Bedrock metrics — rather than a capability ranking this UI is in no position to assert.
 *
 * Neutral on purpose — no app or console module is imported — so the console shares the data without
 * depending on an app's page, and neither app depends on the console. The routes check every composed
 * id against `AGENT_MODEL_IDS` (`lib/server/agentModels.ts`) before a save, so a family added here but
 * not there cannot be saved; the console default may still name an inference profile no preset
 * covers, which is why its section also takes a free-text id.
 */

export const MODEL_FAMILIES = [
  { suffix: "anthropic.claude-opus-5", label: "Opus 5" },
  { suffix: "anthropic.claude-sonnet-5", label: "Sonnet 5" },
  { suffix: "anthropic.claude-fable-5-1", label: "Fable 5.1" },
] as const;

// Not a speed or price tier. `global.` may serve the request from a region outside the US, which is a
// data-residency decision and is invisible in the id — so it is spelled out here rather than left to
// be inferred from a name that looks like a performance setting.
export const MODEL_ENDPOINTS = [
  { value: "us", label: "US", hint: "inference served from US regions only" },
  {
    value: "global",
    label: "Global",
    hint: "may serve the request from outside the US (data residency, not latency)",
  },
] as const;

/** The seed both apps' agents deploy with, pre-selected when a parameter holds nothing yet. */
export const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-5";

/** The two halves a model id decomposes into. */
export interface ModelIdParts {
  endpoint: string;
  family: string;
}

/**
 * The family/endpoint pair a stored model id decomposes into, for pre-selecting the controls.
 *
 * Splits at the FIRST dot: the endpoint never contains one, the family always does. An id with no
 * usable selection — null, empty, or without a dot — decomposes `fallback` instead:
 *
 * - The default (`DEFAULT_MODEL_ID`) is what the app Config tabs want: the controls show what is
 *   actually running rather than a blank the operator has to guess at, while the SAVED selection stays
 *   null, which is what keeps the panel saying "deployed default" instead of claiming a selection.
 * - `null` yields two empty strings, which is what the console's free-text field wants: an id no
 *   preset covers must not light up a preset it does not match.
 *
 * @param modelId the stored id, or null/undefined when nothing is recorded.
 * @param fallback the id to decompose when `modelId` has no usable selection; null for blanks.
 * @returns the endpoint and family.
 */
export function splitModelId(
  modelId: string | null | undefined,
  fallback: string | null = DEFAULT_MODEL_ID,
): ModelIdParts {
  const dot = modelId ? modelId.indexOf(".") : -1;
  if (!modelId || dot < 0) {
    return fallback === null
      ? { endpoint: "", family: "" }
      : splitModelId(fallback, null);
  }
  return { endpoint: modelId.slice(0, dot), family: modelId.slice(dot + 1) };
}

/** The id the two preset controls compose into. */
export function composeModelId(endpoint: string, family: string): string {
  return `${endpoint}.${family}`;
}

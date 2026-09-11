/**
 * The model presets the Defaults section offers, in the same family-plus-endpoint pattern as the
 * apps' Config tabs.
 *
 * A model id is one family plus one endpoint, composed rather than listed: the two are independent
 * choices with different consequences, and a flat list of six ids invites reading `global.` as a
 * capability tier. Duplicated here rather than imported from either app on purpose — the console must
 * not depend on an app's page module, and the console default may name an inference profile no
 * preset covers, which is why the section also takes a free-text id.
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

/** The endpoint and family an id decomposes into; both "" when the id has no dot to split on. */
export function splitModelId(modelId: string): { endpoint: string; family: string } {
  const dot = modelId.indexOf(".");
  if (dot < 0) return { endpoint: "", family: "" };
  return { endpoint: modelId.slice(0, dot), family: modelId.slice(dot + 1) };
}

/** The id the two preset controls compose into. */
export function composeModelId(endpoint: string, family: string): string {
  return `${endpoint}.${family}`;
}

/**
 * Selectable model ids for the parsing agent, as cross-region inference profiles.
 *
 * The parser Lambda applies the same allowlist when it reads the SSM parameter; an id accepted by
 * the Config tab and refused there would be a save that appears to work and then silently falls back
 * to the default. The `global.` variants may route the request outside the US, which is a
 * data-residency decision invisible in the id; the Config tab labels them as such.
 */
export const AGENT_MODEL_IDS = [
  "us.anthropic.claude-opus-5",
  "global.anthropic.claude-opus-5",
  "us.anthropic.claude-sonnet-5",
  "global.anthropic.claude-sonnet-5",
  "us.anthropic.claude-fable-5-1",
  "global.anthropic.claude-fable-5-1",
] as const;

export function isAllowedModelId(value: string): boolean {
  return (AGENT_MODEL_IDS as readonly string[]).includes(value);
}

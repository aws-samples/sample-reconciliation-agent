/**
 * Selectable agent model ids, as cross-region inference profiles — the one allowlist both apps'
 * config routes accept (`/api/recon/config` for the Tier-2 agent, `/api/pipeline/config` for the
 * parsing agent).
 *
 * KEEP IN SYNC with `ALLOWED_MODEL_IDS` in `backend/recon_core/model_select.py`, which enforces the
 * same list when an agent reads its SSM parameter. There is no shared schema layer between the Python
 * runtime and this BFF, so that duplication is deliberate — but an id accepted here and rejected
 * there is a save that appears to work and then silently falls back to the deployed default.
 *
 * The `global.` variants are not a faster tier: they may route the request outside the US, which is
 * a data-residency decision and is invisible in the id. The Config tabs label them as such.
 */
export const AGENT_MODEL_IDS = [
  "us.anthropic.claude-opus-5",
  "global.anthropic.claude-opus-5",
  "us.anthropic.claude-sonnet-5",
  "global.anthropic.claude-sonnet-5",
  "us.anthropic.claude-fable-5-1",
  "global.anthropic.claude-fable-5-1",
] as const;

/** Whether `value` is one of the allowlisted ids. */
export function isAllowedModelId(value: string): boolean {
  return (AGENT_MODEL_IDS as readonly string[]).includes(value);
}

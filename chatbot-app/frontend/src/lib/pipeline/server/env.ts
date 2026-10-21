/**
 * Typed reader for the deal-pipeline BFF environment (design §11 and §13).
 *
 * Every value is read AT CALL TIME rather than captured when the module loads. The reasons are
 * mundane but they matter: `next dev` loads `.env.local` into the server process, tests set
 * `process.env` before importing a route and reset modules between cases, and a route that never
 * touches DynamoDB should not fail to import because `DEALS_TABLE` is unset. Required names throw
 * a message that says which variable is missing and where it comes from, so a half-configured
 * `.env.local` fails on the first request that needs the value rather than with an opaque SDK
 * error about an undefined table name.
 *
 * Three names carry a `PIPELINE_` prefix and are read under that name ONLY. In the composed console
 * the recon BFF and this BFF run in ONE Next.js process, and the recon side owns `ASSETS_BUCKET`,
 * `AGENT_MODEL_PARAM` and `SKILLS_PREFIX` in that container's environment (see
 * `infra/modules/frontend-ecs`). An earlier version fell back to those bare names, which meant a
 * container whose pipeline variables were missing (a recon-only deployment, or a half-filled
 * `.env.local`) pointed the Skills and Config tabs at recon's bucket, recon's live skills and recon's
 * Tier-2 model parameter with no error at all: every one of those exists, and the task role can write
 * them. So a missing `PIPELINE_ASSETS_BUCKET` or `PIPELINE_AGENT_MODEL_PARAM` now fails loudly on the
 * first request that needs it, and `PIPELINE_SKILLS_PREFIX` falls back to the design's default prefix
 * rather than to recon's. The standalone root's `env_local` output and `.env.example` already emit
 * the prefixed names, so nothing that was correctly configured changes.
 */

/** Trimmed value of one variable, or undefined when unset or blank (a blank value is a typo, not a name). */
function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Read a required variable, or throw a message naming it. */
function required(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(
      `${name} is not set — copy it from the Terraform outputs into chatbot-app/frontend/.env.local`,
    );
  }
  return value;
}

/** Read an optional variable, falling back to the design's default. */
function optional(name: string, fallback: string): string {
  return read(name) ?? fallback;
}

export const env = {
  region: (): string => optional("AWS_REGION", "us-east-1"),
  /** The pipeline's own bucket. Never `ASSETS_BUCKET`: in the shared container that is recon's. */
  assetsBucket: (): string => required("PIPELINE_ASSETS_BUCKET"),
  emailsTable: (): string => required("EMAILS_TABLE"),
  dealsTable: (): string => required("DEALS_TABLE"),
  skillProposalsTable: (): string => required("SKILL_PROPOSALS_TABLE"),
  /** Empty string when the knowledge memory is not deployed: memory features degrade to no-ops. */
  knowledgeMemoryId: (): string => optional("KNOWLEDGE_MEMORY_ID", ""),
  /** Empty string when the chat memory is not deployed: chat history is not persisted. */
  chatMemoryId: (): string => optional("CHAT_MEMORY_ID", ""),
  parserFunction: (): string => required("PARSER_FUNCTION"),
  omsUploadFunction: (): string => required("OMS_UPLOAD_FUNCTION"),
  /**
   * The pipeline's own model parameter. Never `AGENT_MODEL_PARAM`: in the shared container that is
   * recon's Tier-2 parameter, and this BFF's `PUT /config` would overwrite it. Required rather than
   * defaulted because a guessed SSM name fails no differently from a wrong one.
   */
  agentModelParam: (): string => required("PIPELINE_AGENT_MODEL_PARAM"),
  assistantModelId: (): string =>
    optional("ASSISTANT_MODEL_ID", "us.anthropic.claude-sonnet-5"),
  /** Relative paths resolve against `process.cwd()`, i.e. `chatbot-app/frontend` under `next dev`. */
  sampleEmailsDir: (): string =>
    optional("SAMPLE_EMAILS_DIR", "../../data/deal-emails"),
  /**
   * S3 prefix the sample corpus is read from when the directory above does not exist — the
   * container case, where `data/` is not shipped.
   */
  samplesPrefix: (): string => optional("PIPELINE_SAMPLES_PREFIX", "samples/"),
  /** The pipeline's own skills prefix. Never `SKILLS_PREFIX`: in the shared container that is recon's live skills. */
  skillsPrefix: (): string => optional("PIPELINE_SKILLS_PREFIX", "skills/"),
  parserPromptKey: (): string =>
    optional("PARSER_PROMPT_KEY", "prompts/parser-system.md"),
};

/** S3 key of the assistant's system prompt. Fixed by the design's S3 layout, so not an env var. */
export const ASSISTANT_PROMPT_KEY = "prompts/assistant-system.md";

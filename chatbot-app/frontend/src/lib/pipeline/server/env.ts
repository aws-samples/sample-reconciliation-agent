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
 * Three names carry a `PIPELINE_` prefix with a fallback to the bare name. In the composed console
 * the recon BFF and this BFF run in ONE Next.js process, and the recon side already owns
 * `ASSETS_BUCKET`, `AGENT_MODEL_PARAM` and `SKILLS_PREFIX` in that container's environment (see
 * `infra/modules/frontend-ecs`). Reading the bare name there would point the pipeline at recon's
 * bucket, recon's model parameter and recon's skills — with no error, because every one of those
 * exists. So the composed deployment sets the prefixed names and they win; the bare names remain
 * only so the standalone root's rendered `.env.local` (`terraform output -raw env_local`) keeps
 * working unchanged.
 */

/** One variable name, or several aliases tried in order (first non-blank wins). */
type Names = string | readonly string[];

function asList(names: Names): readonly string[] {
  return typeof names === "string" ? [names] : names;
}

/** First non-blank value among `names`, in order; undefined when none is set. */
function firstSet(names: Names): string | undefined {
  for (const name of asList(names)) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Read a required variable (or the first of its aliases), or throw a message naming them. */
function required(names: Names): string {
  const value = firstSet(names);
  if (!value) {
    const [primary, ...aliases] = asList(names);
    const label = aliases.length ? `${primary} (or ${aliases.join(", ")})` : primary;
    throw new Error(
      `${label} is not set — copy it from the Terraform outputs into chatbot-app/frontend/.env.local`,
    );
  }
  return value;
}

/** Read an optional variable (or the first of its aliases), falling back to the design's default. */
function optional(names: Names, fallback: string): string {
  return firstSet(names) ?? fallback;
}

export const env = {
  region: (): string => optional("AWS_REGION", "us-east-1"),
  /** Prefixed name first: in the shared container the bare name is recon's bucket. */
  assetsBucket: (): string => required(["PIPELINE_ASSETS_BUCKET", "ASSETS_BUCKET"]),
  emailsTable: (): string => required("EMAILS_TABLE"),
  dealsTable: (): string => required("DEALS_TABLE"),
  skillProposalsTable: (): string => required("SKILL_PROPOSALS_TABLE"),
  /** Empty string when the knowledge memory is not deployed: memory features degrade to no-ops. */
  knowledgeMemoryId: (): string => optional("KNOWLEDGE_MEMORY_ID", ""),
  /** Empty string when the chat memory is not deployed: chat history is not persisted. */
  chatMemoryId: (): string => optional("CHAT_MEMORY_ID", ""),
  parserFunction: (): string => required("PARSER_FUNCTION"),
  omsUploadFunction: (): string => required("OMS_UPLOAD_FUNCTION"),
  /** Prefixed name first: in the shared container the bare name is recon's Tier-2 model parameter. */
  agentModelParam: (): string =>
    optional(
      ["PIPELINE_AGENT_MODEL_PARAM", "AGENT_MODEL_PARAM"],
      "/deal-pipeline-dev/agent-model-id",
    ),
  assistantModelId: (): string =>
    optional("ASSISTANT_MODEL_ID", "us.anthropic.claude-sonnet-5"),
  /** Relative paths resolve against `process.cwd()`, i.e. `chatbot-app/frontend` under `next dev`. */
  sampleEmailsDir: (): string =>
    optional("SAMPLE_EMAILS_DIR", "../../data/deal-emails"),
  /**
   * S3 prefix the sample corpus is read from when the directory above does not exist — the
   * container case, where `data/` is not shipped. Pipeline-only, so no bare-name fallback.
   */
  samplesPrefix: (): string => optional("PIPELINE_SAMPLES_PREFIX", "samples/"),
  /** Prefixed name first: in the shared container the bare name is recon's skills prefix. */
  skillsPrefix: (): string =>
    optional(["PIPELINE_SKILLS_PREFIX", "SKILLS_PREFIX"], "skills/"),
  parserPromptKey: (): string =>
    optional("PARSER_PROMPT_KEY", "prompts/parser-system.md"),
};

/** S3 key of the assistant's system prompt. Fixed by the design's S3 layout, so not an env var. */
export const ASSISTANT_PROMPT_KEY = "prompts/assistant-system.md";

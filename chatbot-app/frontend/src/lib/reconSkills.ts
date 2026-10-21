import {
  createSkillsStore,
  type SkillsStore,
  type SkillsStoreOptions,
} from "@/lib/server/skillsStore";

// The recon agent's live skills and its shared system prompt: SKILL.md objects under
// s3://<assets>/skills/ and the single s3://<assets>/system-prompt.md the agent loads to frame the
// reconciliation workflow. The agent reads the same objects at runtime, so an edit through the Skills
// tab applies within ~60s without a redeploy.
//
// The S3 plumbing is the shared store in lib/server/skillsStore.ts; what stays here is recon's binding
// to ASSETS_BUCKET / SKILLS_PREFIX / SYSTEM_PROMPT_KEY and the option set that IS recon's behaviour:
// every `*.md` under the prefix is a skill, a failed read of a skill or the prompt is "missing" whatever
// the failure, a create on the collection replaces silently, `unknown` cannot be deleted, and the prompt
// may be blank. Those are the store's defaults; they are spelt out here so the contract is visible at
// the one place recon binds it, and so `__tests__/api/reconSkills.test.ts` has something to hold it to.
//
// The environment is read when this module loads and a store — and so an SDK client — is built per
// call, i.e. per request, exactly as the three routes did before they shared this.

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const SKILLS_PREFIX = process.env.SKILLS_PREFIX ?? "skills/";
const SYSTEM_PROMPT_KEY = process.env.SYSTEM_PROMPT_KEY ?? "system-prompt.md";

/** Recon's option set — the shared store's defaults, stated. */
export const RECON_SKILLS_OPTIONS: SkillsStoreOptions = {
  catalogue: "any-markdown",
  missingAsNotFound: "any-error",
  createConflicts: false,
  protectedNames: ["unknown"],
  emptyPromptAllowed: true,
};

/**
 * The recon skills store, bound to the assets bucket.
 *
 * @returns a store over `SKILLS_PREFIX` and `SYSTEM_PROMPT_KEY` in `ASSETS_BUCKET`, with recon's options.
 */
export function reconSkillsStore(): SkillsStore {
  return createSkillsStore({
    bucket: ASSETS_BUCKET,
    prefix: SKILLS_PREFIX,
    promptKey: SYSTEM_PROMPT_KEY,
    region: REGION,
    options: RECON_SKILLS_OPTIONS,
  });
}

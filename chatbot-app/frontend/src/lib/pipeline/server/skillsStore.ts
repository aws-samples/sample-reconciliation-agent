/**
 * The parsing agent's skills and system prompt, as live objects in the pipeline's assets bucket, bound
 * over the shared store in `@/lib/server/skillsStore`.
 *
 * Layout is directory-per-skill: `skills/<name>/SKILL.md`. The parser Lambda loads the same prefix
 * on every run, so a write here changes the next parse without a redeploy — which is exactly what
 * the learning loop demonstrates when a skill proposal is approved.
 *
 * What is the pipeline's own and therefore stays here: which environment variables name the bucket,
 * prefix and prompt key (read at call time, as every pipeline environment value is), the process-wide
 * SDK client from `./aws`, the assistant's second prompt object, and the option set the pipeline
 * chose where it differs from recon — only `<name>/SKILL.md` objects are skills and the directory
 * names them, a missing object is `NoSuchKey`/`NotFound` and nothing else, a create refuses to clobber
 * an existing skill, no skill is undeletable, and the parser prompt may not be blank.
 */

import {
  createSkillsStore,
  type SkillCatalogueEntry,
  type SkillsStoreOptions,
} from "@/lib/server/skillsStore";
import { getText, s3 } from "./aws";
import { ASSISTANT_PROMPT_KEY, env } from "./env";

export { SKILL_NAME } from "@/lib/server/skillsStore";

/** The pipeline's option set: every point on which it differs from recon's defaults. */
export const PIPELINE_SKILLS_OPTIONS: SkillsStoreOptions = {
  catalogue: "skill-md-per-directory",
  missingAsNotFound: "not-found-codes",
  createConflicts: true,
  protectedNames: [],
  emptyPromptAllowed: false,
};

const store = createSkillsStore({
  bucket: env.assetsBucket,
  prefix: env.skillsPrefix,
  promptKey: env.parserPromptKey,
  client: s3,
  options: PIPELINE_SKILLS_OPTIONS,
});

export function skillKey(name: string): string {
  return store.skillKey(name);
}

/** Every skill under the prefix, named by directory, with its frontmatter and key, sorted by name. */
export function listSkills(): Promise<SkillCatalogueEntry[]> {
  return store.listSkills();
}

/** Full SKILL.md, or null when no such skill exists. */
export function getSkill(name: string): Promise<string | null> {
  return store.getSkill(name);
}

/** Create a SKILL.md; throws `SkillExistsError` (see `isSkillExists`) when the skill already exists. */
export function createSkill(name: string, content: string): Promise<void> {
  return store.createSkill(name, content);
}

/** Create or replace a SKILL.md. Callers validate the frontmatter first. */
export function putSkill(name: string, content: string): Promise<void> {
  return store.putSkill(name, content);
}

export function deleteSkill(name: string): Promise<void> {
  return store.deleteSkill(name);
}

/** The parser's system prompt, or null when it has not been seeded. */
export function getParserPrompt(): Promise<string | null> {
  return store.getPrompt();
}

export function putParserPrompt(content: string): Promise<void> {
  return store.putPrompt(content);
}

/** The assistant's system prompt, or null when it has not been seeded (the BFF then uses its built-in). */
export async function getAssistantPrompt(): Promise<string | null> {
  return getText(ASSISTANT_PROMPT_KEY);
}

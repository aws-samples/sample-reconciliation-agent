/**
 * The parsing agent's skills and system prompt, as live objects in the assets bucket.
 *
 * Layout is directory-per-skill: `skills/<name>/SKILL.md`. The parser Lambda loads the same prefix
 * on every run, so a write here changes the next parse without a redeploy — which is exactly what
 * the learning loop demonstrates when a skill proposal is approved.
 */

import { ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";

import { parseSkill, type SkillMeta } from "@/lib/skillFrontmatter";
import { getText, putText, s3 } from "./aws";
import { ASSISTANT_PROMPT_KEY, env } from "./env";

/** Skill names double as S3 path segments; this is the same pattern `validateSkill` enforces. */
export const SKILL_NAME = /^[a-z0-9-]+$/;

/** One catalog entry: frontmatter metadata plus the S3 directory it lives in. */
export interface SkillCatalogEntry extends SkillMeta {
  key: string;
}

export function skillKey(name: string): string {
  return `${env.skillsPrefix()}${name}/SKILL.md`;
}

/** Directory name between the prefix and `/SKILL.md`, or null for objects that are not skills. */
function skillNameFromKey(key: string): string | null {
  const prefix = env.skillsPrefix();
  if (!key.startsWith(prefix) || !key.endsWith("/SKILL.md")) return null;
  const name = key.slice(prefix.length, -"/SKILL.md".length);
  return name && !name.includes("/") ? name : null;
}

/**
 * Every skill under the prefix, with its frontmatter parsed.
 *
 * The directory name wins over the frontmatter `name` when they disagree: the parser resolves skills
 * by directory, so that is the name an operator must use to edit or delete the object.
 */
export async function listSkills(): Promise<SkillCatalogEntry[]> {
  const listed = await s3().send(
    new ListObjectsV2Command({
      Bucket: env.assetsBucket(),
      Prefix: env.skillsPrefix(),
    }),
  );
  const out: SkillCatalogEntry[] = [];
  for (const obj of listed.Contents ?? []) {
    const name = obj.Key ? skillNameFromKey(obj.Key) : null;
    if (!name || !obj.Key) continue;
    const content = (await getText(obj.Key)) ?? "";
    const { body: _body, ...meta } = parseSkill(content);
    out.push({ ...meta, name, key: obj.Key });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Full SKILL.md, or null when no such skill exists. */
export async function getSkill(name: string): Promise<string | null> {
  return getText(skillKey(name));
}

/** Create or replace a SKILL.md. Callers validate the frontmatter first. */
export async function putSkill(name: string, content: string): Promise<void> {
  await putText(skillKey(name), content, "text/markdown");
}

export async function deleteSkill(name: string): Promise<void> {
  await s3().send(
    new DeleteObjectCommand({ Bucket: env.assetsBucket(), Key: skillKey(name) }),
  );
}

/** The parser's system prompt, or null when it has not been seeded. */
export async function getParserPrompt(): Promise<string | null> {
  return getText(env.parserPromptKey());
}

export async function putParserPrompt(content: string): Promise<void> {
  await putText(env.parserPromptKey(), content, "text/markdown");
}

/** The assistant's system prompt, or null when it has not been seeded (the BFF then uses its built-in). */
export async function getAssistantPrompt(): Promise<string | null> {
  return getText(ASSISTANT_PROMPT_KEY);
}

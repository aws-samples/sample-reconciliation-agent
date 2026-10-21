/**
 * One S3 skills store for every app in the console.
 *
 * `createSkillsStore({ bucket, prefix, promptKey, options })` binds one assets bucket and returns the
 * calls both apps make against it: the catalogue of SKILL.md objects under the prefix, one skill's raw
 * markdown, create / replace / delete, and the agent's system prompt as a single object. Each app keeps
 * a thin binding that supplies its own bucket, prefix and key and its own option set: recon in
 * `lib/reconSkills.ts` over `ASSETS_BUCKET` / `SKILLS_PREFIX` / `SYSTEM_PROMPT_KEY`; the pipeline in
 * `lib/pipeline/server/skillsStore.ts` over its `PIPELINE_`-prefixed names.
 *
 * Neutral on purpose: nothing here reads an app's environment or names an app's bucket, so either app
 * can import it without depending on the other. Validation of a skill's frontmatter is not here
 * either — both apps run `validateSkill` (`lib/skillFrontmatter.ts`) in their routes before a write.
 *
 * The two apps disagree on five points, and each is an explicit option whose DEFAULT is what the recon
 * routes have always done (`DEFAULT_SKILLS_STORE_OPTIONS`); the pipeline opts into its own values.
 *
 *   - `catalogue`: which objects are skills. Recon lists every `*.md` under the prefix, names each by
 *     its frontmatter and answers in the listing's order (`"any-markdown"`); the pipeline lists only
 *     `<prefix><name>/SKILL.md`, names each by its directory, adds the object `key` and sorts by name
 *     (`"skill-md-per-directory"`). A missing object inside the listing (deleted between the list and
 *     the read) is an error in the first mode and an empty skill in the second, as each app had it.
 *   - `missingAsNotFound`: what a failed read of one skill or of the prompt means. Recon maps EVERY
 *     failure to "missing" — an access denial reads as a 404 and an empty prompt (`"any-error"`); the
 *     pipeline maps only `NoSuchKey` / `NotFound` and lets anything else propagate (`"not-found-codes"`).
 *   - `createConflicts`: whether creating a skill that already exists is refused (`SkillExistsError`)
 *     or silently replaces it. Recon replaces; the pipeline refuses.
 *   - `protectedNames`: skills a delete refuses (`ProtectedSkillError`). Recon protects `unknown`, the
 *     classification fallback the agent must always find; the pipeline protects none.
 *   - `emptyPromptAllowed`: whether the prompt may be written blank. Recon allows it (the agent then
 *     runs on its built-in framing); the pipeline refuses (`EmptyPromptError`).
 *
 * Errors are not wrapped: each route keeps its own envelope (recon answers the raw SDK message, the
 * pipeline prefixes it). The three refusals above are thrown as errors matched by `name`, not
 * `instanceof`, so a route stays testable with a partially mocked store.
 *
 * The SDK client is built on first use, once per `createSkillsStore` call, unless the caller injects
 * its own. The recon binding creates a store per request and so builds one client per request, as the
 * recon routes always did; the pipeline injects its process-wide lazy client so a route hit once a
 * second does not re-resolve the credential chain.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { parseSkill, type SkillMeta } from "@/lib/skillFrontmatter";

/** Skill names double as S3 path segments; this is the same pattern `validateSkill` enforces. */
export const SKILL_NAME = /^[a-z0-9-]+$/;

/** How the catalogue decides which objects under the prefix are skills. */
export type SkillCatalogueMode = "any-markdown" | "skill-md-per-directory";

/** Which read failures mean "the object is missing" rather than "something is wrong". */
export type SkillMissingMode = "any-error" | "not-found-codes";

export interface SkillsStoreOptions {
  catalogue: SkillCatalogueMode;
  missingAsNotFound: SkillMissingMode;
  /** Refuse to create a skill that already exists (`SkillExistsError`) instead of replacing it. */
  createConflicts: boolean;
  /** Skills a delete refuses (`ProtectedSkillError`). */
  protectedNames: readonly string[];
  /** Whether the prompt may be written blank. */
  emptyPromptAllowed: boolean;
}

/** Recon's behaviour, and therefore the default. */
export const DEFAULT_SKILLS_STORE_OPTIONS: SkillsStoreOptions = {
  catalogue: "any-markdown",
  missingAsNotFound: "any-error",
  createConflicts: false,
  protectedNames: ["unknown"],
  emptyPromptAllowed: true,
};

/** A fixed value, or one read when it is needed (the pipeline reads its environment at call time). */
export type SkillsStoreValue = string | (() => string);

export interface SkillsStoreConfig {
  /** The assets bucket. */
  bucket: SkillsStoreValue;
  /** The prefix skills live under, with its trailing slash, e.g. `skills/`. */
  prefix: SkillsStoreValue;
  /** The key of the system prompt object, e.g. `system-prompt.md`. */
  promptKey: SkillsStoreValue;
  /** Region for the SDK client this store builds. Defaults to `AWS_REGION`, then `us-east-1`. */
  region?: string;
  /** An SDK client to use instead of building one. A thunk, so it is only resolved on first use. */
  client?: () => S3Client;
  /** Deviations from recon's behaviour. Anything not given keeps its default. */
  options?: Partial<SkillsStoreOptions>;
}

/**
 * One catalogue entry: the frontmatter metadata, plus — in `"skill-md-per-directory"` mode only — the
 * S3 key the skill lives at.
 */
export interface SkillCatalogueEntry extends SkillMeta {
  key?: string;
}

export interface SkillsStore {
  /** The options in force, defaults filled in. */
  readonly options: SkillsStoreOptions;
  bucket(): string;
  prefix(): string;
  promptKey(): string;
  /** `<prefix><name>/SKILL.md` — the directory-per-skill key every writer uses. */
  skillKey(name: string): string;
  /** Whether a delete of `name` would be refused. */
  isProtected(name: string): boolean;
  /** Every skill under the prefix, with its frontmatter parsed (see `catalogue`). Errors propagate. */
  listSkills(): Promise<SkillCatalogueEntry[]>;
  /** The full SKILL.md, or null when it is missing (see `missingAsNotFound`). */
  getSkill(name: string): Promise<string | null>;
  /**
   * Create a skill. With `createConflicts`, throws `SkillExistsError` when one already exists;
   * otherwise a plain create-or-replace.
   */
  createSkill(name: string, content: string): Promise<void>;
  /** Create or replace a SKILL.md. Callers validate the frontmatter first. */
  putSkill(name: string, content: string): Promise<void>;
  /** Delete a skill. Throws `ProtectedSkillError` for a name in `protectedNames`, before any S3 call. */
  deleteSkill(name: string): Promise<void>;
  /** The system prompt, or null when it is missing (see `missingAsNotFound`). */
  getPrompt(): Promise<string | null>;
  /** Replace the system prompt. Throws `EmptyPromptError` for a blank prompt unless `emptyPromptAllowed`. */
  putPrompt(content: string): Promise<void>;
}

export const SKILL_EXISTS_ERROR = "SkillExistsError";
export const PROTECTED_SKILL_ERROR = "ProtectedSkillError";
export const EMPTY_PROMPT_ERROR = "EmptyPromptError";

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function errorName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name;
}

/** Whether `err` is the store refusing to create a skill that already exists. */
export function isSkillExists(err: unknown): boolean {
  return errorName(err) === SKILL_EXISTS_ERROR;
}

/** Whether `err` is the store refusing to delete a protected skill. */
export function isProtectedSkill(err: unknown): boolean {
  return errorName(err) === PROTECTED_SKILL_ERROR;
}

/** Whether `err` is the store refusing a blank prompt. */
export function isEmptyPrompt(err: unknown): boolean {
  return errorName(err) === EMPTY_PROMPT_ERROR;
}

/** The two names the S3 SDK gives a missing object, depending on the operation. */
function isNotFoundCode(err: unknown): boolean {
  const name = errorName(err);
  return name === "NoSuchKey" || name === "NotFound";
}

function resolve(value: SkillsStoreValue): string {
  return typeof value === "function" ? value() : value;
}

/**
 * Bind one skills prefix and prompt key in one bucket.
 *
 * @param config the bucket, prefix and prompt key (fixed or read at call time), the client or region
 *   to build one with, and any options that deviate from recon's behaviour.
 * @returns a store whose every call goes to that bucket.
 */
export function createSkillsStore(config: SkillsStoreConfig): SkillsStore {
  const options: SkillsStoreOptions = {
    ...DEFAULT_SKILLS_STORE_OPTIONS,
    ...config.options,
  };
  const bucket = () => resolve(config.bucket);
  const prefix = () => resolve(config.prefix);
  const promptKey = () => resolve(config.promptKey);

  let built: S3Client | undefined;
  const client = (): S3Client => {
    if (config.client) return config.client();
    if (built === undefined) {
      built = new S3Client({
        region: config.region ?? process.env.AWS_REGION ?? "us-east-1",
      });
    }
    return built;
  };

  const skillKey = (name: string) => `${prefix()}${name}/SKILL.md`;

  /** The object's text. Errors propagate. */
  async function readText(key: string): Promise<string> {
    const got = await client().send(
      new GetObjectCommand({ Bucket: bucket(), Key: key }),
    );
    return (await got.Body?.transformToString()) ?? "";
  }

  /** The object's text, or null when it is missing by the store's definition of missing. */
  async function readOrNull(key: string): Promise<string | null> {
    try {
      return await readText(key);
    } catch (err) {
      if (options.missingAsNotFound === "any-error" || isNotFoundCode(err)) {
        return null;
      }
      throw err;
    }
  }

  async function writeText(key: string, body: string): Promise<void> {
    await client().send(
      new PutObjectCommand({
        Bucket: bucket(),
        Key: key,
        Body: body,
        ContentType: "text/markdown",
      }),
    );
  }

  /** Directory name between the prefix and `/SKILL.md`, or null for objects that are not skills. */
  function skillNameFromKey(key: string): string | null {
    const p = prefix();
    if (!key.startsWith(p) || !key.endsWith("/SKILL.md")) return null;
    const name = key.slice(p.length, -"/SKILL.md".length);
    return name && !name.includes("/") ? name : null;
  }

  async function listKeys(): Promise<string[]> {
    const listed = await client().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix() }),
    );
    return (listed.Contents ?? [])
      .map((obj) => obj.Key)
      .filter((key): key is string => typeof key === "string");
  }

  /** Every `*.md` under the prefix, named by frontmatter, in the listing's order. */
  async function listAnyMarkdown(): Promise<SkillCatalogueEntry[]> {
    const out: SkillCatalogueEntry[] = [];
    for (const key of await listKeys()) {
      if (!key.endsWith(".md")) continue;
      const { body: _body, ...meta } = parseSkill(await readText(key));
      out.push(meta);
    }
    return out;
  }

  /**
   * Every `<prefix><name>/SKILL.md`, named by directory, with its key, sorted by name.
   *
   * The directory name wins over the frontmatter `name` when they disagree: the parser resolves skills
   * by directory, so that is the name an operator must use to edit or delete the object.
   */
  async function listSkillMdPerDirectory(): Promise<SkillCatalogueEntry[]> {
    const out: SkillCatalogueEntry[] = [];
    for (const key of await listKeys()) {
      const name = skillNameFromKey(key);
      if (!name) continue;
      let content: string;
      try {
        content = await readText(key);
      } catch (err) {
        // Deleted between the listing and the read: an empty skill, not a failed catalogue.
        if (!isNotFoundCode(err)) throw err;
        content = "";
      }
      const { body: _body, ...meta } = parseSkill(content);
      out.push({ ...meta, name, key });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  const isProtected = (name: string) => options.protectedNames.includes(name);

  return {
    options,
    bucket,
    prefix,
    promptKey,
    skillKey,
    isProtected,
    listSkills: () =>
      options.catalogue === "any-markdown"
        ? listAnyMarkdown()
        : listSkillMdPerDirectory(),
    getSkill: (name) => readOrNull(skillKey(name)),
    async createSkill(name, content) {
      if (
        options.createConflicts &&
        (await readOrNull(skillKey(name))) !== null
      ) {
        throw named(SKILL_EXISTS_ERROR, `skill ${name} already exists`);
      }
      await writeText(skillKey(name), content);
    },
    putSkill: (name, content) => writeText(skillKey(name), content),
    async deleteSkill(name) {
      if (isProtected(name)) {
        throw named(
          PROTECTED_SKILL_ERROR,
          `skill ${name} is protected and cannot be deleted`,
        );
      }
      await client().send(
        new DeleteObjectCommand({ Bucket: bucket(), Key: skillKey(name) }),
      );
    },
    getPrompt: () => readOrNull(promptKey()),
    async putPrompt(content) {
      if (!options.emptyPromptAllowed && content.trim() === "") {
        throw named(EMPTY_PROMPT_ERROR, "the prompt must not be empty");
      }
      await writeText(promptKey(), content);
    },
  };
}

// @vitest-environment node
/**
 * `createSkillsStore` — the one S3 skills store both apps bind.
 *
 * What is pinned: every option defaults to recon's behaviour; each of the five options changes exactly
 * the thing it names and nothing else; the bucket, prefix and prompt key are read when a call is made
 * when given as functions; and the SDK client is built once per store, in the given region, or taken
 * from the caller. The two apps' compositions are covered by their own route tests
 * (`api/reconSkills.test.ts`, `api/pipelineSkills.test.ts`); this file is the store's own contract.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { s3Module } from "../../helpers/awsMocks";
import { scopedEnv } from "../../helpers/env";
import { createFakeS3, noSuchKey } from "../../helpers/fakeS3";

const env = scopedEnv(["AWS_REGION"]);
afterAll(() => env.restore());

const s3Send = vi.fn();
vi.mock("@aws-sdk/client-s3", () => s3Module(s3Send));

const {
  createSkillsStore,
  DEFAULT_SKILLS_STORE_OPTIONS,
  isEmptyPrompt,
  isProtectedSkill,
  isSkillExists,
  SKILL_NAME,
} = await import("@/lib/server/skillsStore");
const { S3Client } = await import("@aws-sdk/client-s3");

const ALPHA =
  "---\nname: alpha\ndescription: First.\ntools: [a___x]\nmodel: m-1\n---\nBody A.";
const BRAVO =
  "---\nname: bravo-frontmatter\ndescription: Second.\n---\nBody B.";
const NOTE = "---\nname: how-to\ndescription: Notes.\n---\nKeep it short.";

const bucket = createFakeS3();
const objects = bucket.objects;
s3Send.mockImplementation(bucket.send);

function sent(tag: string) {
  return s3Send.mock.calls.map((c) => c[0]).filter((c) => c.__cmd === tag);
}

function accessDenied() {
  return Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
}

const BASE = {
  bucket: "assets",
  prefix: "skills/",
  promptKey: "system-prompt.md",
};

beforeEach(() => {
  vi.clearAllMocks();
  env.clear();
  // Seeded out of name order on purpose, so a sort — or its absence — is observable.
  bucket.reset({
    "skills/bravo/SKILL.md": BRAVO,
    "skills/notes/how-to.md": NOTE,
    "skills/alpha/SKILL.md": ALPHA,
    "skills/alpha/examples.txt": "not markdown",
    "system-prompt.md": "Prompt.",
  });
});

describe("options", () => {
  it("default to recon's behaviour, and a partial override keeps the rest", () => {
    expect(createSkillsStore(BASE).options).toEqual(
      DEFAULT_SKILLS_STORE_OPTIONS,
    );
    expect(DEFAULT_SKILLS_STORE_OPTIONS).toEqual({
      catalogue: "any-markdown",
      missingAsNotFound: "any-error",
      createConflicts: false,
      protectedNames: ["unknown"],
      emptyPromptAllowed: true,
    });
    const store = createSkillsStore({
      ...BASE,
      options: { createConflicts: true },
    });
    expect(store.options).toEqual({
      ...DEFAULT_SKILLS_STORE_OPTIONS,
      createConflicts: true,
    });
  });

  it("expose the name pattern validateSkill enforces", () => {
    expect(SKILL_NAME.test("record-match-review")).toBe(true);
    expect(SKILL_NAME.test("../etc")).toBe(false);
  });
});

describe("catalogue", () => {
  it('"any-markdown" lists every .md under the prefix, by frontmatter name, in the listing\'s order, without keys', async () => {
    const list = await createSkillsStore(BASE).listSkills();
    expect(list).toEqual([
      {
        name: "bravo-frontmatter",
        description: "Second.",
        tools: [],
        model: null,
      },
      { name: "how-to", description: "Notes.", tools: [], model: null },
      { name: "alpha", description: "First.", tools: ["a___x"], model: "m-1" },
    ]);
    expect(sent("List")).toEqual([
      { __cmd: "List", Bucket: "assets", Prefix: "skills/" },
    ]);
  });

  it('"any-markdown" lets a failed read inside the listing propagate', async () => {
    s3Send
      .mockImplementationOnce(bucket.send)
      .mockRejectedValueOnce(accessDenied());
    await expect(createSkillsStore(BASE).listSkills()).rejects.toThrow(
      "Access Denied",
    );
  });

  it('"skill-md-per-directory" lists only <name>/SKILL.md, named by directory, with keys, sorted', async () => {
    const store = createSkillsStore({
      ...BASE,
      options: { catalogue: "skill-md-per-directory" },
    });
    expect(await store.listSkills()).toEqual([
      {
        name: "alpha",
        description: "First.",
        tools: ["a___x"],
        model: "m-1",
        key: "skills/alpha/SKILL.md",
      },
      // The directory wins over `name: bravo-frontmatter`: it is what the parser resolves by.
      {
        name: "bravo",
        description: "Second.",
        tools: [],
        model: null,
        key: "skills/bravo/SKILL.md",
      },
    ]);
  });

  it('"skill-md-per-directory" treats an object that vanished after the listing as an empty skill, and propagates anything else', async () => {
    const store = createSkillsStore({
      ...BASE,
      options: { catalogue: "skill-md-per-directory" },
    });
    // The listing is in seed order, so the first read after it is `bravo`'s: that is the one that vanishes.
    s3Send
      .mockImplementationOnce(bucket.send)
      .mockRejectedValueOnce(noSuchKey());
    const list = await store.listSkills();
    expect(list.map((s) => s.name)).toEqual(["alpha", "bravo"]);
    expect(list.find((s) => s.name === "alpha")).toMatchObject({
      description: "First.",
    });
    expect(list.find((s) => s.name === "bravo")).toMatchObject({
      description: "",
      key: "skills/bravo/SKILL.md",
    });

    s3Send
      .mockImplementationOnce(bucket.send)
      .mockRejectedValueOnce(accessDenied());
    await expect(store.listSkills()).rejects.toThrow("Access Denied");
  });
});

describe("getSkill and getPrompt", () => {
  it("read <prefix><name>/SKILL.md and the prompt key, answering the text", async () => {
    const store = createSkillsStore(BASE);
    expect(await store.getSkill("alpha")).toBe(ALPHA);
    expect(await store.getPrompt()).toBe("Prompt.");
    expect(sent("GetObject").map((c) => c.Key)).toEqual([
      "skills/alpha/SKILL.md",
      "system-prompt.md",
    ]);
    expect(store.skillKey("alpha")).toBe("skills/alpha/SKILL.md");
  });

  it('"any-error" answers null for a missing object AND for any other failure', async () => {
    const store = createSkillsStore(BASE);
    expect(await store.getSkill("nope")).toBeNull();
    s3Send.mockRejectedValueOnce(accessDenied());
    expect(await store.getSkill("alpha")).toBeNull();
    s3Send.mockRejectedValueOnce(accessDenied());
    expect(await store.getPrompt()).toBeNull();
  });

  it('"not-found-codes" answers null only for NoSuchKey / NotFound and rethrows the rest', async () => {
    const store = createSkillsStore({
      ...BASE,
      options: { missingAsNotFound: "not-found-codes" },
    });
    expect(await store.getSkill("nope")).toBeNull();
    s3Send.mockRejectedValueOnce(
      Object.assign(new Error("nf"), { name: "NotFound" }),
    );
    expect(await store.getSkill("alpha")).toBeNull();
    s3Send.mockRejectedValueOnce(accessDenied());
    await expect(store.getSkill("alpha")).rejects.toThrow("Access Denied");
    s3Send.mockRejectedValueOnce(accessDenied());
    await expect(store.getPrompt()).rejects.toThrow("Access Denied");
  });
});

describe("createSkill and putSkill", () => {
  const charlie = "---\nname: charlie\ndescription: Third.\n---\nBody C.";

  it("write <prefix><name>/SKILL.md as markdown", async () => {
    await createSkillsStore(BASE).putSkill("charlie", charlie);
    expect(sent("PutObject")).toEqual([
      {
        __cmd: "PutObject",
        Bucket: "assets",
        Key: "skills/charlie/SKILL.md",
        Body: charlie,
        ContentType: "text/markdown",
      },
    ]);
  });

  it("without createConflicts, a create replaces an existing skill silently and reads nothing first", async () => {
    await createSkillsStore(BASE).createSkill("alpha", charlie);
    expect(objects["skills/alpha/SKILL.md"]).toBe(charlie);
    expect(sent("GetObject")).toEqual([]);
  });

  it("with createConflicts, a create refuses an existing skill by name and writes nothing", async () => {
    const store = createSkillsStore({
      ...BASE,
      options: { createConflicts: true },
    });
    const err = await store
      .createSkill("alpha", charlie)
      .catch((e: unknown) => e);
    expect(isSkillExists(err)).toBe(true);
    expect((err as Error).message).toBe("skill alpha already exists");
    expect(sent("PutObject")).toEqual([]);
    expect(objects["skills/alpha/SKILL.md"]).toBe(ALPHA);

    await store.createSkill("charlie", charlie);
    expect(objects["skills/charlie/SKILL.md"]).toBe(charlie);
    expect(isSkillExists(new Error("skill alpha already exists"))).toBe(false);
  });
});

describe("deleteSkill", () => {
  it("refuses a protected name before any S3 call, and deletes the rest", async () => {
    objects["skills/unknown/SKILL.md"] =
      "---\nname: unknown\ndescription: Fallback.\n---\n";
    const store = createSkillsStore(BASE);
    const err = await store.deleteSkill("unknown").catch((e: unknown) => e);
    expect(isProtectedSkill(err)).toBe(true);
    expect(s3Send).not.toHaveBeenCalled();
    expect(store.isProtected("unknown")).toBe(true);
    expect(store.isProtected("alpha")).toBe(false);

    await store.deleteSkill("alpha");
    expect(sent("Delete")).toEqual([
      { __cmd: "Delete", Bucket: "assets", Key: "skills/alpha/SKILL.md" },
    ]);
    expect(objects["skills/alpha/SKILL.md"]).toBeUndefined();
  });

  it("with no protected names, deletes `unknown` like any other skill", async () => {
    objects["skills/unknown/SKILL.md"] = "x";
    await createSkillsStore({
      ...BASE,
      options: { protectedNames: [] },
    }).deleteSkill("unknown");
    expect(objects["skills/unknown/SKILL.md"]).toBeUndefined();
  });
});

describe("putPrompt", () => {
  it("writes the prompt key as markdown, blank included, by default", async () => {
    const store = createSkillsStore(BASE);
    await store.putPrompt("");
    expect(sent("PutObject")).toEqual([
      {
        __cmd: "PutObject",
        Bucket: "assets",
        Key: "system-prompt.md",
        Body: "",
        ContentType: "text/markdown",
      },
    ]);
    expect(objects["system-prompt.md"]).toBe("");
  });

  it("with emptyPromptAllowed off, refuses a blank prompt by name and writes nothing", async () => {
    const store = createSkillsStore({
      ...BASE,
      options: { emptyPromptAllowed: false },
    });
    for (const blank of ["", "  \n\t"]) {
      const err = await store.putPrompt(blank).catch((e: unknown) => e);
      expect(isEmptyPrompt(err)).toBe(true);
    }
    expect(sent("PutObject")).toEqual([]);
    await store.putPrompt("Stage deals.");
    expect(objects["system-prompt.md"]).toBe("Stage deals.");
  });
});

describe("binding", () => {
  it("reads a bucket, prefix or prompt key given as a function at call time", async () => {
    let suffix = "one";
    const store = createSkillsStore({
      bucket: () => `assets-${suffix}`,
      prefix: () => `${suffix}/skills/`,
      promptKey: () => `${suffix}/prompt.md`,
    });
    objects["one/skills/alpha/SKILL.md"] = ALPHA;
    objects["two/prompt.md"] = "Two.";

    expect(await store.getSkill("alpha")).toBe(ALPHA);
    suffix = "two";
    expect(await store.getPrompt()).toBe("Two.");
    expect(store.bucket()).toBe("assets-two");
    expect(store.skillKey("alpha")).toBe("two/skills/alpha/SKILL.md");
    expect(sent("GetObject")).toEqual([
      {
        __cmd: "GetObject",
        Bucket: "assets-one",
        Key: "one/skills/alpha/SKILL.md",
      },
      { __cmd: "GetObject", Bucket: "assets-two", Key: "two/prompt.md" },
    ]);
  });

  it("builds one SDK client per store, on first use, in the given region", async () => {
    const store = createSkillsStore({ ...BASE, region: "eu-west-1" });
    expect(S3Client).not.toHaveBeenCalled();
    await store.getSkill("alpha");
    await store.getPrompt();
    await store.putSkill("alpha", ALPHA);
    expect(S3Client).toHaveBeenCalledTimes(1);
    expect(S3Client).toHaveBeenCalledWith({ region: "eu-west-1" });
  });

  it("defaults the region to AWS_REGION, then us-east-1", async () => {
    await createSkillsStore(BASE).getPrompt();
    expect(S3Client).toHaveBeenLastCalledWith({ region: "us-east-1" });
    env.set({ AWS_REGION: "ap-southeast-2" });
    await createSkillsStore(BASE).getPrompt();
    expect(S3Client).toHaveBeenLastCalledWith({ region: "ap-southeast-2" });
  });

  it("uses an injected client and builds none of its own", async () => {
    const injected = vi.fn(
      () => ({ send: bucket.send }) as unknown as InstanceType<typeof S3Client>,
    );
    await createSkillsStore({ ...BASE, client: injected }).getPrompt();
    expect(injected).toHaveBeenCalled();
    expect(S3Client).not.toHaveBeenCalled();
  });
});

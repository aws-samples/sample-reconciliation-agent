import { describe, it, expect } from "vitest";
import {
  parseSkill,
  validateSkill,
  yamlScalarHazard,
} from "@/lib/skillFrontmatter";

const VALID = `---
name: timing-break
description: Value date differs.
tools: [general-ledger___search_ledger, managed-kb___Retrieve]
model: us.amazon.nova-2-lite-v1:0
---
Compare the two sides.`;

describe("skillFrontmatter", () => {
  it("parses metadata (tools list + model) + body", () => {
    const p = parseSkill(VALID);
    expect(p.name).toBe("timing-break");
    expect(p.tools).toEqual([
      "general-ledger___search_ledger",
      "managed-kb___Retrieve",
    ]);
    expect(p.model).toBe("us.amazon.nova-2-lite-v1:0");
    expect(p.body).toContain("Compare");
  });

  it("defaults tools to [] and model to null when absent", () => {
    const p = parseSkill(`---\nname: x\ndescription: d\n---\nbody`);
    expect(p.tools).toEqual([]);
    expect(p.model).toBeNull();
  });

  it("accepts a valid skill", () => {
    expect(validateSkill(VALID, "timing-break")).toBeNull();
  });

  it("rejects name mismatch, bad name pattern, missing description", () => {
    expect(validateSkill(VALID, "other-name")).toMatch(/must equal/);
    expect(validateSkill(VALID, "Bad Name")).toMatch(/\^\[a-z0-9-\]/);
    expect(
      validateSkill(
        VALID.replace("description: Value date differs.", "description:"),
        "timing-break",
      ),
    ).toMatch(/description/);
  });

  // The Lambdas of both apps read the block with a YAML parser; the tab must not accept a
  // description YAML would then truncate (` #`) or reject (`: `, a leading indicator).
  it.each([
    ["Rated BB #1 pick", / #/],
    ["Read this: carefully", /: /],
    ["*bold* start", /starts with '\*'/],
    ["- a list item", /starts with '-'/],
    ["[draft] rules", /starts with '\['/],
  ])(
    "rejects the unquoted description %j that YAML would misread",
    (description, reason) => {
      const md = VALID.replace(
        "description: Value date differs.",
        `description: ${description}`,
      );
      const problem = validateSkill(md, "timing-break");
      expect(problem).toMatch(reason);
      expect(problem).toMatch(/double quotes/);
    },
  );

  it("accepts the same descriptions once they are double-quoted, and plain prose with a bare colon or hash", () => {
    for (const description of [
      '"Rated BB #1 pick"',
      '"Read this: carefully"',
      "'*bold* start'",
    ]) {
      const md = VALID.replace(
        "description: Value date differs.",
        `description: ${description}`,
      );
      expect(validateSkill(md, "timing-break")).toBeNull();
    }
    // `a:b` and `#1` after a word are plain text to YAML too.
    const md = VALID.replace(
      "description: Value date differs.",
      "description: Ratio a:b, item#1.",
    );
    expect(validateSkill(md, "timing-break")).toBeNull();
  });

  it("classifies hazards directly", () => {
    expect(yamlScalarHazard("plain words")).toBeNull();
    expect(yamlScalarHazard('"anything: at #all"')).toBeNull();
    expect(yamlScalarHazard("x\ty")).toMatch(/tab/);
    expect(yamlScalarHazard("? maybe")).toMatch(/starts with/);
    expect(yamlScalarHazard("-dash-joined is fine")).toBeNull();
  });
});

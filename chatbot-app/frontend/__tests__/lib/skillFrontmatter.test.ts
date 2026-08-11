import { describe, it, expect } from "vitest";
import { parseSkill, validateSkill } from "@/lib/skillFrontmatter";

const VALID = `---
name: timing-break
description: Value date differs.
tools: [search_ledger, search_guidance]
model: us.amazon.nova-2-lite-v1:0
---
Compare the two sides.`;

describe("skillFrontmatter", () => {
  it("parses metadata (tools list + model) + body", () => {
    const p = parseSkill(VALID);
    expect(p.name).toBe("timing-break");
    expect(p.tools).toEqual(["search_ledger", "search_guidance"]);
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
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Targeted skill edits and the counterparties CSV parser (src/lib/pipeline/server/chatAgent.ts).
// Skills are far larger than one tool call can carry, so the assistant sends find/replace pairs or
// an appended section and the server resolves them against the live SKILL.md.

const getSkill = vi.fn();
vi.mock("@/lib/pipeline/server/skillsStore", () => ({
  getSkill: (...args: unknown[]) => getSkill(...args),
  listSkills: vi.fn(),
  getAssistantPrompt: vi.fn(),
}));
vi.mock("@/lib/pipeline/server/aws", () => ({
  bedrock: vi.fn(),
  getText: vi.fn(),
}));
vi.mock("@/lib/pipeline/server/dealStore", () => ({ getDeal: vi.fn(), listDeals: vi.fn() }));
vi.mock("@/lib/pipeline/server/emailStore", () => ({ getEmail: vi.fn() }));
vi.mock("@/lib/pipeline/server/proposalStore", () => ({ createProposal: vi.fn() }));
vi.mock("@/lib/pipeline/server/memoryClient", () => ({
  batchDelete: vi.fn(),
  createRuleEvent: vi.fn(),
  EDGE_CASES_NAMESPACE: "deal-pipeline/edge-cases/deal-desk",
  appendChatEvent: vi.fn(),
  listChatEvents: vi.fn(),
  listRecords: vi.fn(),
}));

import {
  buildProposedContent,
  parseCounterpartiesCsv,
} from "@/lib/pipeline/server/chatAgent";

const SKILL = "---\nname: deal-parsing\n---\n\n## U5 Agents\n\nLeft Agent is copied as written.\n";

describe("buildProposedContent", () => {
  beforeEach(() => {
    getSkill.mockReset();
    getSkill.mockResolvedValue(SKILL);
  });

  it("applies a unique find/replace edit against the live skill", async () => {
    const out = await buildProposedContent("deal-parsing", {
      edits: [{ find: "copied as written.", replace: "the OMS canonical name." }],
    });
    expect(out).toContain("Left Agent is the OMS canonical name.");
    expect(out.startsWith("---\nname: deal-parsing")).toBe(true);
  });

  it("inserts the replacement literally — `$` patterns are text, not String.replace directives", async () => {
    // With a string replacement, "$&" would re-insert the match, "$'" the whole rest of the skill
    // and "$$" a single "$". The skills are full of `$` in code spans and currency notes, so a model
    // edit that kept one would splice kilobytes of the file into the proposal unnoticed.
    const find = "copied as written.";
    const replace = "kept as `$&`, not `$'`, `$`` or `$$`; amounts like $500M stay verbatim.";
    const out = await buildProposedContent("deal-parsing", { edits: [{ find, replace }] });
    expect(out).toContain(`Left Agent is ${replace}\n`);
    expect(out).toHaveLength(SKILL.length - find.length + replace.length);
  });

  it("appends a section after the current content", async () => {
    const out = await buildProposedContent("deal-parsing", {
      append_markdown: "## Learned rules\n\n- Loans carry Covenant Status #.",
    });
    expect(out.endsWith("## Learned rules\n\n- Loans carry Covenant Status #.\n")).toBe(true);
    expect(out).toContain("## U5 Agents");
  });

  it("rejects an edit whose find text is absent or ambiguous", async () => {
    await expect(
      buildProposedContent("deal-parsing", { edits: [{ find: "not here", replace: "x" }] }),
    ).rejects.toThrow(/occurs 0 times/);
    await expect(
      buildProposedContent("deal-parsing", { edits: [{ find: "\n", replace: "x" }] }),
    ).rejects.toThrow(/must occur exactly once/);
  });

  it("requires one of the three forms and an existing skill", async () => {
    await expect(buildProposedContent("deal-parsing", {})).rejects.toThrow(/provide edits/);
    getSkill.mockResolvedValue(null);
    await expect(
      buildProposedContent("missing", { append_markdown: "x" }),
    ).rejects.toThrow(/not found/);
  });

  it("passes a full replacement through untouched", async () => {
    const out = await buildProposedContent("deal-parsing", { proposed_content: "---\nname: x\n---\nbody" });
    expect(out).toBe("---\nname: x\n---\nbody");
    expect(getSkill).not.toHaveBeenCalled();
  });
});

describe("parseCounterpartiesCsv", () => {
  it("reads canonical names with quoted, semicolon-separated aliases", () => {
    const rows = parseCounterpartiesCsv(
      'canonical_name,aliases\nHarbor Point,"Harbor Point Securities;HPS"\nNorthgate,Northgate Markets\n\n',
    );
    expect(rows).toEqual([
      { canonical: "Harbor Point", aliases: ["Harbor Point Securities", "HPS"] },
      { canonical: "Northgate", aliases: ["Northgate Markets"] },
    ]);
  });

  it("skips unparseable lines instead of failing", () => {
    expect(parseCounterpartiesCsv('garbage"line\nKestrel,"Kestrel Bank"')).toEqual([
      { canonical: "Kestrel", aliases: ["Kestrel Bank"] },
    ]);
  });
});

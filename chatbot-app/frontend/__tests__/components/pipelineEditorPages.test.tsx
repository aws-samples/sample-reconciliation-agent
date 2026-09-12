/**
 * The admin editor pages: parser model, one skill, the parser prompt, and the proposals queue.
 *
 * Each has one write and one line that reports how it went. The property pinned here is that a refused
 * write — a 403 for a caller outside the admin group, a failed SSM or S3 put — is drawn as an error and
 * announced as one, never in the colour of the confirmation it would otherwise be mistaken for. The
 * `data-tone` attribute is the verdict; the colour assertion is there so the two cannot drift apart.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillProposal } from "@/lib/pipeline/types";

const api = {
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  getSkill: vi.fn(),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
  getParserPrompt: vi.fn(),
  saveParserPrompt: vi.fn(),
  listProposals: vi.fn(),
  decideProposal: vi.fn(),
};
vi.mock("@/lib/pipelineApi", () => ({
  getConfig: (...a: unknown[]) => api.getConfig(...a),
  saveConfig: (...a: unknown[]) => api.saveConfig(...a),
  getSkill: (...a: unknown[]) => api.getSkill(...a),
  saveSkill: (...a: unknown[]) => api.saveSkill(...a),
  deleteSkill: (...a: unknown[]) => api.deleteSkill(...a),
  getParserPrompt: (...a: unknown[]) => api.getParserPrompt(...a),
  saveParserPrompt: (...a: unknown[]) => api.saveParserPrompt(...a),
  listProposals: (...a: unknown[]) => api.listProposals(...a),
  decideProposal: (...a: unknown[]) => api.decideProposal(...a),
}));
// An admin viewer: the write controls are only rendered for one, and the server's refusal is what
// these cases exercise — a token that lost the group mid-session, or a put the service rejected.
vi.mock("@/hooks/usePipelineSubject", () => ({
  usePipelineSubject: () => ({ subject: "sub-1", groups: ["deal-desk-admins"], isAdmin: true }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The skill editor reads its route params through React's `use`, which the React 18 in this test
// environment does not have (the app runs on the copy Next bundles). Resolve a `{ value }` stand-in
// synchronously so the page renders without a Suspense boundary.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, use: (p: unknown) => (p as { value: unknown }).value };
});

import ConfigPage from "@/app/pipeline/config/page";
import SkillEditorPage from "@/app/pipeline/skills/[name]/page";
import ParserPromptPage from "@/app/pipeline/skills/system-prompt/page";
import ProposalsPage from "@/app/pipeline/skills/proposals/page";

const REFUSED = new Error('this endpoint requires membership of the "deal-desk-admins" group');

const PROPOSAL: SkillProposal = {
  proposal_id: "pr_1",
  skill_name: "deal-parsing",
  summary: "Add the covenant status rule for Loans",
  rationale: "Every Loan record needs Covenant Status #; the OMS rejects the upload without it.",
  proposed_content: "# deal-parsing\n\nLoans carry Covenant Status # 1–4.\n",
  current_content: "# deal-parsing\n",
  status: "PENDING",
  source: { kind: "assistant", session_id: "s-1", deal_id: "dl_1" },
  created_at: "2026-08-05T14:10:00Z",
};

/** The one outcome line on the page, asserted as an error: announced, tagged, and red. */
async function expectFailure(text: string | RegExp) {
  const failure = await screen.findByRole("alert");
  expect(failure).toHaveAttribute("data-tone", "error");
  expect(failure).toHaveTextContent(text);
  expect(failure.style.color).toContain("--rc-red");
  expect(failure.style.color).not.toContain("--rc-cyan");
  expect(screen.queryByRole("status")).toBeNull();
}

/** The one outcome line on the page, asserted as a confirmation, with no error left behind. */
async function expectSuccess(text: string | RegExp) {
  const success = await screen.findByRole("status");
  expect(success).toHaveAttribute("data-tone", "success");
  expect(success).toHaveTextContent(text);
  expect(success.style.color).toContain("--rc-cyan");
  expect(screen.queryByRole("alert")).toBeNull();
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
});

describe("ConfigPage", () => {
  it("draws a failed apply as an error and a successful one as a confirmation", async () => {
    api.getConfig.mockResolvedValue({ modelId: "us.anthropic.claude-sonnet-5" });
    api.saveConfig
      .mockRejectedValueOnce(new Error("config write failed: AccessDeniedException"))
      .mockResolvedValueOnce({ modelId: "us.anthropic.claude-opus-5" });
    render(<ConfigPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Opus 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await expectFailure("config write failed: AccessDeniedException");

    // The selection is still pending after a refusal, so Apply is still offered.
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await expectSuccess("The parser now invokes us.anthropic.claude-opus-5 on its next run.");
  });
});

describe("SkillEditorPage", () => {
  const params = { value: { name: "deal-parsing" } } as unknown as Promise<{ name: string }>;

  it("draws a failed save as an error and a successful one as a confirmation", async () => {
    api.getSkill.mockResolvedValue({ name: "deal-parsing", content: "# deal-parsing\n" });
    api.saveSkill.mockRejectedValueOnce(REFUSED).mockResolvedValueOnce(undefined);
    render(<SkillEditorPage params={params} />);

    const box = await screen.findByRole("textbox", { name: "Skill content" });
    fireEvent.change(box, {
      target: { value: "# deal-parsing\n\nLoans carry Covenant Status # 1–4.\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await expectFailure(/requires membership of the "deal-desk-admins" group/);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await expectSuccess(/^Saved — the parser loads skills from S3/);
  });
});

describe("ParserPromptPage", () => {
  it("draws a failed save as an error and a successful one as a confirmation", async () => {
    api.getParserPrompt.mockResolvedValue({ content: "Read the email as a deal desk analyst." });
    api.saveParserPrompt
      .mockRejectedValueOnce(new Error("pipeline API error 500"))
      .mockResolvedValueOnce(undefined);
    render(<ParserPromptPage />);

    const box = await screen.findByRole("textbox", { name: "Parser system prompt" });
    fireEvent.change(box, { target: { value: "Read the email as a deal desk analyst. Cite evidence." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await expectFailure("pipeline API error 500");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await expectSuccess("Saved — the next parse uses this prompt.");
  });
});

describe("ProposalsPage", () => {
  it("draws a refused approve as an error and a decision as a confirmation", async () => {
    api.listProposals.mockResolvedValue([PROPOSAL]);
    api.decideProposal.mockRejectedValueOnce(REFUSED).mockResolvedValueOnce({
      ...PROPOSAL,
      status: "REJECTED",
      decided_at: "2026-08-05T14:20:00Z",
      decided_by: "sub-1",
    });
    render(<ProposalsPage />);

    fireEvent.click(await screen.findByRole("button", { name: /Add the covenant status rule/ }));
    fireEvent.click(screen.getByRole("button", { name: "Approve & apply" }));
    await expectFailure(/requires membership of the "deal-desk-admins" group/);
    // Nothing was applied, so the proposal is still waiting and both decisions are still offered.
    expect(screen.getByRole("button", { name: "Approve & apply" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await expectSuccess("Rejected — the skill is unchanged.");
  });
});

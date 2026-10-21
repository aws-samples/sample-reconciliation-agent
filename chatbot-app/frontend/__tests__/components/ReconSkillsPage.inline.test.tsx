/**
 * The recon Skills page — the in-page catalogue and editor over `/api/recon/skills`.
 *
 * Written ahead of the shared skills catalogue (docs/shared-spine-proposal.md §8b) to pin what the
 * recon page does today, so the shared components' inline mode can be held to it:
 *
 *   - every skill is a tile with its frontmatter `tools[]` as chips (or "none") and a `model:` chip
 *     when the skill overrides the model;
 *   - clicking a tile opens the skill IN PLACE, read-only, with an "Edit ▸" that turns it into the
 *     editor; the tile's own "Edit ▸" opens the editor directly; nothing navigates away;
 *   - Save is offered as soon as the editor opens — there is no admin gate and no "nothing changed"
 *     gate — and it PUTs the textarea's content for the skill being edited, then closes the editor,
 *     confirms, and reloads the catalogue;
 *   - "+ New skill" opens the template and Save creates the skill under the name in its frontmatter;
 *   - the `unknown` fallback skill has no Delete; another skill's Delete asks first, then deletes and
 *     reloads (the confirmation is the shared dialog since the shared catalogue landed; it was a native
 *     `confirm` before — the one interaction this file had to follow);
 *   - a failed load is an error placeholder; a failed save is reported and the editor stays open.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillType } from "@/lib/reconApi";

const api = {
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  saveSkill: vi.fn(),
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
};
vi.mock("@/lib/reconApi", () => ({
  listSkills: (...a: unknown[]) => api.listSkills(...a),
  getSkill: (...a: unknown[]) => api.getSkill(...a),
  saveSkill: (...a: unknown[]) => api.saveSkill(...a),
  createSkill: (...a: unknown[]) => api.createSkill(...a),
  deleteSkill: (...a: unknown[]) => api.deleteSkill(...a),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import SkillsManagerPage from "@/app/recon/skills/page";

const SKILLS: SkillType[] = [
  {
    name: "record-match-review",
    description:
      "Compare the ledger record with the counterparty notice field by field.",
    tools: ["general-ledger___search_ledger", "managed-kb___Retrieve"],
    model: "us.anthropic.claude-sonnet-5",
  },
  {
    name: "unknown",
    description: "Fallback when no other procedure applies.",
    tools: [],
    model: null,
  },
];

const RECORD_MATCH = `---
name: record-match-review
description: Compare the ledger record with the counterparty notice field by field.
tools: [general-ledger___search_ledger, managed-kb___Retrieve]
model: us.anthropic.claude-sonnet-5
---
Walk the fields in order and note every mismatch.`;

/** The tile for one skill: the panel that carries the read-only-view title. */
function tile(name: string): HTMLElement {
  return screen.getByTitle(`View ${name} (read-only)`);
}

/** The editor panel (or the read-only view): the panel around the eyebrow that names it. */
function panelNamed(eyebrow: string): HTMLElement {
  return screen.getByText(eyebrow).closest(".rc-panel") as HTMLElement;
}

async function show() {
  render(<SkillsManagerPage />);
  await screen.findByText("record-match-review");
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listSkills.mockResolvedValue(SKILLS);
  api.getSkill.mockImplementation(async (name: string) => ({
    name,
    content: RECORD_MATCH,
  }));
  api.saveSkill.mockResolvedValue({ name: "record-match-review" });
  api.createSkill.mockResolvedValue({ name: "fee-break-review" });
  api.deleteSkill.mockResolvedValue({ deleted: "record-match-review" });
});

describe("recon Skills page", () => {
  it("draws each skill as a tile with its tools and model chips, and withholds Delete from `unknown`", async () => {
    await show();

    const match = tile("record-match-review");
    expect(within(match).getByText(SKILLS[0].description)).toBeInTheDocument();
    expect(
      within(match).getByText("general-ledger___search_ledger"),
    ).toBeInTheDocument();
    expect(
      within(match).getByText("managed-kb___Retrieve"),
    ).toBeInTheDocument();
    expect(
      within(match).getByText("model: us.anthropic.claude-sonnet-5"),
    ).toBeInTheDocument();
    expect(
      within(match).getByRole("button", { name: "Edit ▸" }),
    ).toBeInTheDocument();
    expect(
      within(match).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();

    const unknown = tile("unknown");
    expect(within(unknown).getByText("none")).toBeInTheDocument();
    expect(within(unknown).queryByText(/^model:/)).toBeNull();
    expect(
      within(unknown).getByRole("button", { name: "Edit ▸" }),
    ).toBeInTheDocument();
    // The fallback classification type must always exist, so the page never offers to delete it.
    expect(
      within(unknown).queryByRole("button", { name: "Delete" }),
    ).toBeNull();

    expect(
      screen.getByRole("link", { name: "Edit system prompt" }),
    ).toHaveAttribute("href", "/recon/skills/system-prompt");
    // Nothing is open until a tile is clicked.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("opens a clicked tile in place, read-only, and Edit ▸ turns it into the editor whose Save PUTs the content", async () => {
    await show();

    fireEvent.click(tile("record-match-review"));
    await screen.findByText("Viewing record-match-review · read-only");
    expect(api.getSkill).toHaveBeenCalledWith("record-match-review");
    await screen.findByText(
      /Walk the fields in order and note every mismatch\./,
    );
    // Read-only: nothing to save yet, and the page is still the catalogue.
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(tile("unknown")).toBeInTheDocument();

    fireEvent.click(
      within(panelNamed("Viewing record-match-review · read-only")).getByRole(
        "button",
        { name: "Edit ▸" },
      ),
    );
    await screen.findByText("Editing record-match-review");
    const box = screen.getByRole("textbox");
    await waitFor(() => expect(box).toHaveValue(RECORD_MATCH));

    const edited = `${RECORD_MATCH}\nThen check the settlement date.`;
    fireEvent.change(box, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved — applies to the agent within ~60s.");
    expect(api.saveSkill).toHaveBeenCalledWith("record-match-review", edited);
    expect(api.createSkill).not.toHaveBeenCalled();
    // The editor closes and the catalogue is re-read so the tiles reflect the new frontmatter.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.listSkills).toHaveBeenCalledTimes(2);
  });

  it("the tile's Edit ▸ opens the editor directly, with Save offered before anything changed", async () => {
    await show();

    fireEvent.click(
      within(tile("record-match-review")).getByRole("button", {
        name: "Edit ▸",
      }),
    );
    await screen.findByText("Editing record-match-review");
    expect(screen.queryByText(/read-only/)).toBeNull();
    const box = screen.getByRole("textbox");
    await waitFor(() => expect(box).toHaveValue(RECORD_MATCH));

    // No dirty gate and no admin gate: Save is live as soon as the skill is loaded.
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await screen.findByText("Saved — applies to the agent within ~60s.");
    expect(api.saveSkill).toHaveBeenCalledWith(
      "record-match-review",
      RECORD_MATCH,
    );
  });

  it("+ New skill opens the template and Save creates the skill named in its frontmatter", async () => {
    await show();

    fireEvent.click(screen.getByRole("button", { name: "+ New skill" }));
    await screen.findByText("New skill (SKILL.md)");
    const box = screen.getByRole("textbox");
    expect((box as HTMLTextAreaElement).value).toContain(
      "name: new-skill-name",
    );
    expect(api.getSkill).not.toHaveBeenCalled();

    const content = `---
name: fee-break-review
description: Trace a fee difference to its schedule.
tools: [general-ledger___search_ledger]
---
Find the fee schedule first.`;
    fireEvent.change(box, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("Saved — applies to the agent within ~60s.");
    expect(api.createSkill).toHaveBeenCalledWith("fee-break-review", content);
    expect(api.saveSkill).not.toHaveBeenCalled();
    expect(api.listSkills).toHaveBeenCalledTimes(2);
  });

  it("Cancel closes the editor without writing", async () => {
    await show();

    fireEvent.click(
      within(tile("record-match-review")).getByRole("button", {
        name: "Edit ▸",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue(RECORD_MATCH),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "scratch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(api.saveSkill).not.toHaveBeenCalled();
    expect(api.listSkills).toHaveBeenCalledTimes(1);
  });

  it("Delete asks first, then deletes the skill and reloads the catalogue", async () => {
    // Before the shared catalogue this was a native `window.confirm`; it is now the same confirmation
    // dialog the recon Lessons page uses for memory records. What is pinned is unchanged: nothing is
    // deleted until the question is answered, then the skill goes and the grid is re-read.
    await show();

    fireEvent.click(
      within(tile("record-match-review")).getByRole("button", {
        name: "Delete",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: 'Delete skill "record-match-review"?',
    });
    expect(api.deleteSkill).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(api.deleteSkill).toHaveBeenCalledWith("record-match-review"),
    );
    await waitFor(() => expect(api.listSkills).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("dialog")).toBeNull();
    // Deleting does not open anything: still the catalogue, no editor.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("draws a failed catalogue load as an error placeholder", async () => {
    api.listSkills.mockRejectedValue(new Error("boom"));
    render(<SkillsManagerPage />);

    const failure = await screen.findByText(
      /Failed to load skills — Error: boom/,
    );
    expect(failure.closest("[data-kind]")).toHaveAttribute(
      "data-kind",
      "error",
    );
  });

  it("reports a failed save and keeps the editor open with the draft", async () => {
    api.saveSkill.mockRejectedValue(
      new Error("frontmatter name 'x' must equal 'record-match-review'"),
    );
    await show();

    fireEvent.click(
      within(tile("record-match-review")).getByRole("button", {
        name: "Edit ▸",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue(RECORD_MATCH),
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "---\nname: x\n---\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(
      "Error: frontmatter name 'x' must equal 'record-match-review'",
    );
    expect(screen.getByRole("textbox")).toHaveValue("---\nname: x\n---\n");
    expect(api.listSkills).toHaveBeenCalledTimes(1);
  });
});

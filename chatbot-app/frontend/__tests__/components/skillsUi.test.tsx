/**
 * The shared skills UI — `SkillEditor`, `SkillsCatalog` and `PromptEditorPage` — what both Skills tabs
 * mount.
 *
 * The recon page test (`ReconSkillsPage.inline.test.tsx`) and the pipeline editor-pages test cover each
 * app's composition; what is pinned here is the components' own contract. Every default is the recon
 * page's: everyone may write, Save is offered whether or not anything changed, `unknown` has no Delete,
 * an empty catalogue is an empty grid, no object key is shown. The pipeline's differences are opt-ins
 * (`disableSaveWhenClean`, `readOnly`, `canEdit`, `protectedNames`, `emptyState`, `path`, mode
 * "route"), and each changes exactly the thing it names.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PromptEditorPage } from "@/components/app-ui/PromptEditorPage";
import { SkillEditor } from "@/components/app-ui/SkillEditor";
import {
  SkillsCatalog,
  type SkillsCatalogApi,
} from "@/components/app-ui/SkillsCatalog";

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

const SKILL =
  "---\nname: deal-parsing\ndescription: Stage deals.\n---\nTerm loans are Loan records.";

describe("SkillEditor", () => {
  it("offers Save as soon as the content is there, changed or not, and hands Save the draft", () => {
    const onSave = vi.fn();
    render(<SkillEditor name="deal-parsing" content={SKILL} onSave={onSave} />);

    expect(screen.getByText("Editing deal-parsing")).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(SKILL);

    fireEvent.change(screen.getByRole("textbox", { name: "Skill content" }), {
      target: { value: `${SKILL}\nBonds are Fixed.` },
    });
    fireEvent.click(save);
    expect(onSave).toHaveBeenLastCalledWith(`${SKILL}\nBonds are Fixed.`);
  });

  it("with disableSaveWhenClean, withholds Save until the draft differs from the content, and again once it is saved", () => {
    const onSave = vi.fn();
    const { rerender } = render(
      <SkillEditor
        name="deal-parsing"
        content={SKILL}
        onSave={onSave}
        disableSaveWhenClean
      />,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();

    const edited = `${SKILL}\nBonds are Fixed.`;
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: edited },
    });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledWith(edited);

    // The caller wrote and passes the new baseline: the box is clean again.
    rerender(
      <SkillEditor
        name="deal-parsing"
        content={edited}
        onSave={onSave}
        disableSaveWhenClean
      />,
    );
    expect(screen.getByRole("textbox")).toHaveValue(edited);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("read-only: the box is read-only, nothing writes, and Edit ▸ / Close are the only actions", () => {
    const onEdit = vi.fn();
    const onClose = vi.fn();
    render(
      <SkillEditor
        name="deal-parsing"
        content={SKILL}
        readOnly
        onSave={vi.fn()}
        onEdit={onEdit}
        onClose={onClose}
        onDelete={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Viewing deal-parsing · read-only"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit ▸" }));
    expect(onEdit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Delete asks first: Cancel deletes nothing, confirming calls onDelete and closes the dialog", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(
      <SkillEditor
        name="deal-parsing"
        content={SKILL}
        onSave={vi.fn()}
        onDelete={onDelete}
        deleteWarning="The parser stops loading it."
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    let dialog = screen.getByRole("dialog", {
      name: 'Delete skill "deal-parsing"?',
    });
    expect(
      within(dialog).getByText("The parser stops loading it."),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names a new skill, hides the eyebrow on request, and shows a loading placeholder until the content arrives", () => {
    const { rerender } = render(
      <SkillEditor
        name={null}
        content="---\nname: x\n---\n"
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByText("New skill (SKILL.md)")).toBeInTheDocument();
    // A new skill has nothing to delete, whatever the caller passed.
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();

    rerender(
      <SkillEditor
        name="deal-parsing"
        content={SKILL}
        onSave={vi.fn()}
        eyebrow={null}
      />,
    );
    expect(screen.queryByText(/Editing/)).toBeNull();

    rerender(
      <SkillEditor name="deal-parsing" content={null} onSave={vi.fn()} />,
    );
    expect(screen.getByText("◆ loading deal-parsing…")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

type Skill = { name: string; description: string };

/** The five calls as mocks, typed so a case can script one (`mockRejectedValue`) and still pass the set as `api`. */
type CatalogApiMocks = {
  [K in keyof SkillsCatalogApi<Skill>]: ReturnType<typeof vi.fn>;
};

function catalogApi(skills: Skill[] = []): CatalogApiMocks {
  return {
    listSkills: vi.fn().mockResolvedValue(skills),
    getSkill: vi
      .fn()
      .mockResolvedValue({ name: "deal-parsing", content: SKILL }),
    createSkill: vi.fn().mockResolvedValue(undefined),
    saveSkill: vi.fn().mockResolvedValue(undefined),
    deleteSkill: vi.fn().mockResolvedValue(undefined),
  };
}

const ROUTE = {
  mode: "route" as const,
  basePath: "/pipeline/skills",
  eyebrow: "Parsing rules",
  newTemplate: "---\nname: new-skill-name\ndescription: d\n---\nBody",
};

describe("SkillsCatalog (route mode)", () => {
  it("draws each skill as a link to its detail route with the caller's footer, and no in-place actions", async () => {
    const api = catalogApi([
      { name: "deal-parsing", description: "Stage deals." },
      { name: "unknown", description: "" },
    ]);
    render(
      <SkillsCatalog
        api={api}
        {...ROUTE}
        headerActions={<a href="/pipeline/skills/proposals">Proposals</a>}
        tileFooter={(s) => <span>skills/{s.name}/SKILL.md</span>}
      />,
    );

    const tile = await screen.findByRole("link", { name: /deal-parsing/ });
    expect(tile).toHaveAttribute("href", "/pipeline/skills/deal-parsing");
    expect(
      within(tile).getByText("skills/deal-parsing/SKILL.md"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("no description in the frontmatter"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit ▸" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(api.getSkill).not.toHaveBeenCalled();
  });

  it("offers + New skill to writers only, and a create names the skill from its frontmatter and hands it to onCreated", async () => {
    const api = catalogApi([]);
    const onCreated = vi.fn();
    const { rerender } = render(
      <SkillsCatalog
        api={api}
        {...ROUTE}
        canEdit={false}
        onCreated={onCreated}
      />,
    );
    await waitFor(() => expect(api.listSkills).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "+ New skill" })).toBeNull();

    rerender(
      <SkillsCatalog api={api} {...ROUTE} canEdit onCreated={onCreated} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ New skill" }));
    const box = screen.getByRole("textbox", { name: "Skill content" });
    expect(box).toHaveValue(ROUTE.newTemplate);

    const content =
      "---\nname: bond-rules\ndescription: Bonds are Fixed.\n---\nBody";
    fireEvent.change(box, { target: { value: content } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(api.createSkill).toHaveBeenCalledWith("bond-rules", content),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("bond-rules"));
    // The page navigates; the catalogue is not re-read here.
    expect(api.listSkills).toHaveBeenCalledTimes(1);
  });

  it("refuses a new skill with no frontmatter name before any call", async () => {
    const api = catalogApi([]);
    render(<SkillsCatalog api={api} {...ROUTE} />);
    fireEvent.click(await screen.findByRole("button", { name: "+ New skill" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "no frontmatter at all" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("frontmatter must include a name");
    expect(api.createSkill).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("no frontmatter at all");
  });

  it("draws emptyState in place of the grid when given, and an empty grid otherwise", async () => {
    const api = catalogApi([]);
    const { rerender } = render(
      <SkillsCatalog api={api} {...ROUTE} emptyState={<p>nothing here</p>} />,
    );
    expect(await screen.findByText("nothing here")).toBeInTheDocument();

    rerender(<SkillsCatalog api={api} {...ROUTE} />);
    await waitFor(() => expect(screen.queryByText("nothing here")).toBeNull());
    expect(screen.queryByText(/loading skills/)).toBeNull();
  });
});

describe("SkillsCatalog (inline mode)", () => {
  it("withholds Delete from protectedNames and Edit / Delete / New from a reader", async () => {
    const api = catalogApi([
      { name: "deal-parsing", description: "Stage deals." },
      { name: "keep-me", description: "Protected." },
    ]);
    const { rerender } = render(
      <SkillsCatalog
        api={api}
        mode="inline"
        eyebrow="e"
        newTemplate="t"
        protectedNames={["keep-me"]}
      />,
    );
    const protectedTile = await screen.findByTitle("View keep-me (read-only)");
    expect(
      within(protectedTile).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
    expect(
      within(protectedTile).getByRole("button", { name: "Edit ▸" }),
    ).toBeInTheDocument();
    const other = screen.getByTitle("View deal-parsing (read-only)");
    expect(
      within(other).getByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();

    rerender(
      <SkillsCatalog
        api={api}
        mode="inline"
        eyebrow="e"
        newTemplate="t"
        canEdit={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Edit ▸" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ New skill" })).toBeNull();
    // A reader can still open a tile to read it — and is offered no Edit ▸ there either.
    fireEvent.click(screen.getByTitle("View deal-parsing (read-only)"));
    await screen.findByText("Viewing deal-parsing · read-only");
    expect(screen.queryByRole("button", { name: "Edit ▸" })).toBeNull();
  });

  it("reports a refused delete and keeps the catalogue as it was", async () => {
    const api = catalogApi([
      { name: "deal-parsing", description: "Stage deals." },
    ]);
    api.deleteSkill.mockRejectedValue(new Error("refused"));
    render(
      <SkillsCatalog api={api} mode="inline" eyebrow="e" newTemplate="t" />,
    );

    fireEvent.click(
      within(
        await screen.findByTitle("View deal-parsing (read-only)"),
      ).getByRole("button", { name: "Delete" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Error: refused");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByTitle("View deal-parsing (read-only)"),
    ).toBeInTheDocument();
    expect(api.listSkills).toHaveBeenCalledTimes(1);
  });

  it("does not reload when the caller passes a fresh api object on every render", async () => {
    const api = catalogApi([
      { name: "deal-parsing", description: "Stage deals." },
    ]);
    const { rerender } = render(
      <SkillsCatalog
        api={{ ...api }}
        mode="inline"
        eyebrow="e"
        newTemplate="t"
      />,
    );
    await screen.findByTitle("View deal-parsing (read-only)");
    rerender(
      <SkillsCatalog
        api={{ ...api }}
        mode="inline"
        eyebrow="e"
        newTemplate="t"
      />,
    );
    rerender(
      <SkillsCatalog
        api={{ ...api }}
        mode="inline"
        eyebrow="e"
        newTemplate="t"
      />,
    );
    expect(api.listSkills).toHaveBeenCalledTimes(1);
  });
});

describe("PromptEditorPage", () => {
  const PAGE = {
    eyebrow: "Overall workflow",
    title: "System Prompt",
    backHref: "/recon/skills",
    savedMessage: "Saved — applies within ~60s.",
  };

  beforeEach(() => vi.clearAllMocks());

  it("loads once, saves whatever is in the box (blank included) without a change gate, and reports the outcome by tone", async () => {
    const load = vi.fn().mockResolvedValue({ content: "Old prompt." });
    const save = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Access Denied"));
    render(<PromptEditorPage {...PAGE} load={load} save={save} />);

    const box = await screen.findByRole("textbox", { name: "System prompt" });
    expect(box).toHaveValue("Old prompt.");
    expect(screen.getByRole("link", { name: "← Skills" })).toHaveAttribute(
      "href",
      "/recon/skills",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const success = await screen.findByRole("status");
    expect(success).toHaveAttribute("data-tone", "success");
    expect(success).toHaveTextContent("Saved — applies within ~60s.");
    expect(save).toHaveBeenCalledWith("");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const failure = await screen.findByRole("alert");
    expect(failure).toHaveAttribute("data-tone", "error");
    expect(failure).toHaveTextContent("Error: Access Denied");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("with disableSaveWhenClean, withholds Save until the prompt differs from what was loaded or saved", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <PromptEditorPage
        {...PAGE}
        load={vi.fn().mockResolvedValue({ content: "Old." })}
        save={save}
        disableSaveWhenClean
      />,
    );
    const box = await screen.findByRole("textbox");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(box, { target: { value: "New." } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("status");
    expect(save).toHaveBeenCalledWith("New.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("read-only: the box is read-only and Save is withheld; the object key is shown when given", async () => {
    render(
      <PromptEditorPage
        {...PAGE}
        load={vi.fn().mockResolvedValue({ content: "Old." })}
        save={vi.fn()}
        readOnly
        path="prompts/parser-system.md"
        textareaLabel="Parser system prompt"
      />,
    );
    const box = await screen.findByRole("textbox", {
      name: "Parser system prompt",
    });
    expect(box).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.getByText("prompts/parser-system.md")).toBeInTheDocument();
  });

  it("draws a failed load as an error placeholder", async () => {
    render(
      <PromptEditorPage
        {...PAGE}
        load={vi.fn().mockRejectedValue(new Error("nope"))}
        save={vi.fn()}
      />,
    );
    const failure = await screen.findByText("Failed to load — Error: nope");
    expect(failure.closest("[data-kind]")).toHaveAttribute(
      "data-kind",
      "error",
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

/**
 * The shared memory panel — what both apps mount over their memory routes.
 *
 * The recon Lessons page test and the pipeline Memory Manager test cover each app's composition; what
 * is pinned here is the panel's own contract. Every default is the recon page's: selection controls
 * for everyone, no Refresh, memory text and capture date as the columns, notes drawn as dashed
 * `Placeholder` boxes, a refused delete reported as "Delete failed — …" above the table, and a failed
 * records load degrading to the empty state without a word. The app-specific parts are slots and
 * options the pipeline opts into (`noteStyle="inline"`, its own delete label, `showLoadError`). A
 * reload is triggered by Refresh and by `refreshToken` and nothing else — in particular not by a
 * caller passing fresh callbacks on every render.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MemoryPanel,
  type MemoryPanelRecord,
} from "@/components/app-ui/MemoryPanel";
import type { MemoryStrategyResponse } from "@/lib/memoryStrategy";

const RECORDS: MemoryPanelRecord[] = [
  {
    id: "rec-1",
    content: "Paydown breaks under 1 USD are rounding.",
    createdAt: "2026-08-05T14:00:00Z",
  },
  {
    id: "rec-2",
    content: "Fix the facility mapping before comparing amounts.",
    createdAt: "2026-08-09T09:00:00Z",
  },
];

const STRATEGY: MemoryStrategyResponse = {
  configured: true,
  memoryStatus: "ACTIVE",
  strategies: [
    {
      id: "str-1",
      name: "lessons_learned",
      description: null,
      type: "CUSTOM",
      configurationType: "SEMANTIC_OVERRIDE",
      status: "ACTIVE",
      namespaces: [],
      extraction: null,
      consolidation: null,
    },
  ],
};

const NOT_CONFIGURED: MemoryStrategyResponse = {
  configured: false,
  memoryStatus: null,
  strategies: [],
};

const api = {
  listRecords: vi.fn(),
  deleteRecords: vi.fn(),
  getStrategy: vi.fn(),
};

/** The panel with the required props and whatever a case overrides. */
function mount(
  props: Partial<Parameters<typeof MemoryPanel<MemoryPanelRecord>>[0]> = {},
) {
  return render(
    <MemoryPanel
      listRecords={api.listRecords}
      deleteRecords={api.deleteRecords}
      getStrategy={api.getStrategy}
      memoryIdEnvName="TEST_MEMORY_ID"
      deleteWarning="Gone for good."
      {...props}
    />,
  );
}

/** Select rec-1 and confirm its deletion; the service's answer is whatever the case mocked. */
async function deleteFirstRecord(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "Select memory record rec-1" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }),
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listRecords.mockResolvedValue(RECORDS);
  api.getStrategy.mockResolvedValue(STRATEGY);
});

describe("MemoryPanel", () => {
  it("defaults to the memory and capture-date columns with selection controls for everyone", async () => {
    mount();
    expect(await screen.findByText(RECORDS[1].content)).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
    expect(screen.getByText("Captured")).toBeTruthy();
    expect(screen.getByText("2026-08-09")).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Select all memory records" }),
    ).toBeTruthy();
    expect(
      screen.getAllByRole("checkbox", { name: /Select memory record/ }),
    ).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    // A strategy with no override says so rather than rendering empty prompt boxes.
    fireEvent.click(screen.getByRole("button", { name: /lessons_learned/ }));
    expect(screen.getByText(/No prompt override/)).toBeTruthy();
    // No extraction model is drawn as a dash; an empty namespaces list is left blank, as the recon
    // page left it.
    expect(screen.getAllByText("—")).toHaveLength(1);
  });

  it("renders the caller's columns and hides every selection control when deleting is not allowed", async () => {
    mount({
      canDelete: false,
      columns: [
        {
          key: "shout",
          header: "Rule",
          width: "1fr",
          render: (r) => r.content.toUpperCase(),
        },
      ],
    });
    expect(
      await screen.findByText(RECORDS[0].content.toUpperCase()),
    ).toBeTruthy();
    expect(screen.getByText("Rule")).toBeTruthy();
    expect(screen.queryByText("Memory")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete selected" }),
    ).toBeNull();
  });

  it("names the app's memory variable in the not-configured notes, drawn as dashed boxes by default", async () => {
    api.listRecords.mockResolvedValue([]);
    api.getStrategy.mockResolvedValue(NOT_CONFIGURED);
    mount();
    expect(
      await screen.findByText(
        "TEST_MEMORY_ID not configured — no strategy to show.",
      ),
    ).toHaveAttribute("data-kind", "empty");
    expect(
      screen.getByText(
        "No consolidated memory yet — or TEST_MEMORY_ID not configured.",
      ),
    ).toHaveAttribute("data-kind", "empty");
  });

  it("renders the header, header link and add-rule slots", async () => {
    mount({
      header: <h2>Agent Long-Term Memory</h2>,
      headerLink: <a href="/elsewhere">Proposals</a>,
      addRule: <form aria-label="Add a rule" />,
    });
    expect(await screen.findByText("Agent Long-Term Memory")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Add a rule" })).toBeTruthy();
  });

  it("reloads on Refresh and on refreshToken, calling onLoad each time, and not on a bare re-render", async () => {
    const onLoad = vi.fn();
    const view = mount({ refresh: true, refreshToken: 0, onLoad });
    await screen.findByText(RECORDS[0].content);
    expect(api.listRecords).toHaveBeenCalledTimes(1);
    expect(api.getStrategy).toHaveBeenCalledTimes(1);
    expect(onLoad).toHaveBeenCalledTimes(1);

    // Fresh lambdas, same token: no reload. A caller writing `listRecords={() => ...}` must not put
    // the panel in a request loop.
    view.rerender(
      <MemoryPanel
        listRecords={(...a) => api.listRecords(...a)}
        deleteRecords={(...a) => api.deleteRecords(...a)}
        getStrategy={(...a) => api.getStrategy(...a)}
        memoryIdEnvName="TEST_MEMORY_ID"
        deleteWarning="Gone for good."
        refresh
        refreshToken={0}
        onLoad={onLoad}
      />,
    );
    expect(api.listRecords).toHaveBeenCalledTimes(1);

    view.rerender(
      <MemoryPanel
        listRecords={api.listRecords}
        deleteRecords={api.deleteRecords}
        getStrategy={api.getStrategy}
        memoryIdEnvName="TEST_MEMORY_ID"
        deleteWarning="Gone for good."
        refresh
        refreshToken={1}
        onLoad={onLoad}
      />,
    );
    expect(api.listRecords).toHaveBeenCalledTimes(2);
    expect(onLoad).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(api.listRecords).toHaveBeenCalledTimes(3);
    expect(api.getStrategy).toHaveBeenCalledTimes(3);
    expect(onLoad).toHaveBeenCalledTimes(3);
  });

  it("degrades a failed records load to the empty state without a word by default", async () => {
    api.listRecords.mockRejectedValue(new Error("recon API error 500"));
    api.getStrategy.mockRejectedValue(new Error("recon API error 500"));
    mount();
    expect(await screen.findByText(/No consolidated memory yet/)).toBeTruthy();
    expect(screen.queryByText(/Could not load records/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // The strategy failure is still named, in a dashed box, on its own.
    expect(
      await screen.findByText(
        "Could not read the memory strategy — Error: recon API error 500",
      ),
    ).toHaveAttribute("data-kind", "error");
  });

  it("names a failed records load beside the empty table when asked, as a one-line notice inline", async () => {
    api.listRecords.mockRejectedValue(new Error("pipeline API error 500"));
    api.getStrategy.mockRejectedValue(new Error("pipeline API error 502"));
    mount({ showLoadError: true, noteStyle: "inline" });
    const notes = await screen.findAllByRole("alert");
    expect(notes.map((n) => n.textContent)).toEqual([
      "Could not read the memory strategy — Error: pipeline API error 502",
      "Could not load records — Error: pipeline API error 500",
    ]);
    notes.forEach((n) => {
      expect(n).toHaveAttribute("data-tone", "error");
      expect(n).not.toHaveAttribute("data-kind");
    });
    expect(screen.getByText(/No consolidated memory yet/)).toBeTruthy();
  });

  it("names a single record in the confirmation and reports a delete that threw above the table", async () => {
    api.deleteRecords.mockRejectedValue(new Error("recon API error 403"));
    mount();
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Select memory record rec-1",
      }),
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete 1 memory record?");
    expect(within(dialog).getByText("Gone for good.")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    // The recon page's words, in a dashed error box, inside the records block and above the table.
    const note = await within(screen.getByTestId("memory-records")).findByText(
      "Delete failed — Error: recon API error 403",
    );
    expect(note).toHaveAttribute("data-kind", "error");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      note.compareDocumentPosition(screen.getByText(RECORDS[0].content)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nothing left the list, and the selection survives so the operator can retry.
    expect(screen.getByText(RECORDS[0].content)).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: "Select memory record rec-1" }),
    ).toBeChecked();

    // Clear empties the selection and with it the action bar.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("draws its notes as one-line notices with the caller's delete label in the inline style", async () => {
    api.getStrategy.mockResolvedValue(NOT_CONFIGURED);
    api.deleteRecords.mockResolvedValue({
      deleted: [],
      failed: [{ id: "rec-1", error: "AccessDeniedException" }],
    });
    mount({ noteStyle: "inline", deleteErrorLabel: "Not deleted — " });

    const quiet = await screen.findByText(
      "TEST_MEMORY_ID not configured — no strategy to show.",
    );
    expect(quiet.tagName).toBe("P");
    expect(quiet).not.toHaveAttribute("data-kind");

    await deleteFirstRecord();
    const reason = await within(
      screen.getByTestId("memory-records"),
    ).findByRole("alert");
    expect(reason).toHaveTextContent(
      "Not deleted — rec-1: AccessDeniedException",
    );
    expect(reason).toHaveAttribute("data-tone", "error");
    expect(reason).not.toHaveAttribute("data-kind");
    expect(
      screen.getByRole("checkbox", { name: "Select memory record rec-1" }),
    ).toBeChecked();
  });
});

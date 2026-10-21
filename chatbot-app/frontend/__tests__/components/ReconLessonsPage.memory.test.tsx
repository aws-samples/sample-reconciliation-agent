/**
 * The memory half of the recon Lessons page — the consolidated long-term memory the agent recalls.
 *
 * Written ahead of the shared MemoryPanel extraction to pin what the recon page does today: records
 * are listed newest first, each with its `domain`; the header checkbox selects every record; "Delete
 * selected" asks for confirmation before anything reaches the API; a record the service refused to
 * delete stays on screen, still selected, with the reason in a dashed "Delete failed — …" box above
 * the table; the extraction strategy behind the records is shown as a read-only card, and its own
 * notes are dashed boxes too; and a memory failure leaves the decisions table above it standing
 * without announcing itself — long-term memory is advisory context.
 */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Lesson,
  MemoryRecord,
  MemoryStrategyResponse,
} from "@/lib/reconApi";

const api = {
  listLessons: vi.fn(),
  getMemoryRecords: vi.fn(),
  deleteMemoryRecords: vi.fn(),
  getMemoryStrategy: vi.fn(),
};
vi.mock("@/lib/reconApi", () => ({
  listLessons: (...a: unknown[]) => api.listLessons(...a),
  getMemoryRecords: (...a: unknown[]) => api.getMemoryRecords(...a),
  deleteMemoryRecords: (...a: unknown[]) => api.deleteMemoryRecords(...a),
  getMemoryStrategy: (...a: unknown[]) => api.getMemoryStrategy(...a),
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

import LessonsPage from "@/app/recon/lessons/page";

/** One ledger row with a comment, so the tab's comment-only default shows it. */
const LESSON: Lesson = {
  lesson_id: "les-1",
  created_at: "2026-08-01T00:00:00Z",
  domain: "lending",
  class_id: "C-7",
  item_id: "IT-1",
  trigger: "USER_CORRECTION",
  user_comment: "Facility mapping must be fixed first.",
};

// Memory domains deliberately differ from the lesson's, so a domain cell is unique on the page.
const OLDER: MemoryRecord = {
  id: "rec-1",
  domain: "loan_ops",
  namespace: "reconciliation/lessons/loan_ops",
  content: "Fix the facility mapping before comparing amounts.",
  createdAt: "2026-08-05T14:00:00Z",
};
const NEWER: MemoryRecord = {
  id: "rec-2",
  domain: "treasury",
  namespace: "reconciliation/lessons/treasury",
  content: "Paydown breaks under 1 USD are rounding; close without action.",
  createdAt: "2026-08-09T09:00:00Z",
};

const PROMPT =
  "Extract generalizable reconciliation lessons from the analyst's decision…";
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
      namespaces: ["reconciliation/lessons/{actorId}"],
      extraction: {
        kind: "semanticExtractionOverride",
        modelId: "us.anthropic.claude-sonnet-5",
        appendToPrompt: PROMPT,
      },
      consolidation: null,
    },
  ],
};

const recordCheckbox = (id: string) =>
  screen.getByRole("checkbox", { name: `Select memory record ${id}` });

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listLessons.mockResolvedValue([LESSON]);
  // Served oldest first: the page is what sorts them.
  api.getMemoryRecords.mockResolvedValue([OLDER, NEWER]);
  api.getMemoryStrategy.mockResolvedValue(STRATEGY);
});

describe("LessonsPage — agent long-term memory", () => {
  it("lists the records newest first, each with its domain, under the read-only strategy card", async () => {
    render(<LessonsPage />);

    expect(await screen.findByText(NEWER.content)).toBeTruthy();
    expect(screen.getByText(OLDER.content)).toBeTruthy();
    expect(screen.getByText("treasury")).toBeTruthy();
    expect(screen.getByText("loan_ops")).toBeTruthy();

    const boxes = screen.getAllByRole("checkbox", {
      name: /Select memory record/,
    });
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Select memory record rec-2",
      "Select memory record rec-1",
    ]);

    // The strategy card: identity and status on the row, the live prompt behind the disclosure.
    expect(screen.getByText("lessons_learned")).toBeTruthy();
    expect(screen.getByText("CUSTOM · SEMANTIC_OVERRIDE")).toBeTruthy();
    expect(screen.getByText("ACTIVE")).toBeTruthy();
    expect(screen.queryByText(PROMPT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /lessons_learned/ }));
    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(screen.getByText("us.anthropic.claude-sonnet-5")).toBeTruthy();
    expect(screen.getByText("reconciliation/lessons/{actorId}")).toBeTruthy();
  });

  it("selects every record from the header checkbox and asks for confirmation before deleting", async () => {
    api.deleteMemoryRecords.mockResolvedValue({
      deleted: ["rec-1", "rec-2"],
      failed: [],
    });
    render(<LessonsPage />);
    await screen.findByText(NEWER.content);

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all memory records" }),
    );
    expect(recordCheckbox("rec-1")).toBeChecked();
    expect(recordCheckbox("rec-2")).toBeChecked();
    expect(screen.getByText("2 selected")).toBeTruthy();

    // Opening the confirmation is not a delete.
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Delete 2 memory records?");
    expect(api.deleteMemoryRecords).not.toHaveBeenCalled();

    // Neither is cancelling it.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteMemoryRecords).not.toHaveBeenCalled();
    expect(screen.getByText(NEWER.content)).toBeTruthy();

    // Confirming is.
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() =>
      expect(api.deleteMemoryRecords).toHaveBeenCalledTimes(1),
    );
    const [ids] = api.deleteMemoryRecords.mock.calls[0] as [string[]];
    expect([...ids].sort()).toEqual(["rec-1", "rec-2"]);
    expect(await screen.findByText(/No consolidated memory yet/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a record the service refused to delete, still selected, with the reason", async () => {
    api.deleteMemoryRecords.mockResolvedValue({
      deleted: ["rec-2"],
      failed: [{ id: "rec-1", error: "AccessDeniedException" }],
    });
    render(<LessonsPage />);
    await screen.findByText(NEWER.content);

    fireEvent.click(recordCheckbox("rec-1"));
    fireEvent.click(recordCheckbox("rec-2"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    // The reason, in the recon page's words, in a dashed error box that sits above the table.
    const note = await screen.findByText(
      "Delete failed — rec-1: AccessDeniedException",
    );
    expect(note).toHaveAttribute("data-kind", "error");
    expect(
      note.compareDocumentPosition(screen.getByText(OLDER.content)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Only the id the service confirmed leaves the list; the refused one stays, still selected.
    expect(screen.queryByText(NEWER.content)).toBeNull();
    expect(screen.getByText(OLDER.content)).toBeTruthy();
    expect(recordCheckbox("rec-1")).toBeChecked();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when the memory is not configured instead of showing an empty table", async () => {
    api.getMemoryRecords.mockResolvedValue([]);
    api.getMemoryStrategy.mockResolvedValue({
      configured: false,
      memoryStatus: null,
      strategies: [],
    });
    render(<LessonsPage />);

    // Both notes are dashed boxes, as the recon page drew them.
    expect(
      await screen.findByText(
        /RECON_MEMORY_ID not configured — no strategy to show/,
      ),
    ).toHaveAttribute("data-kind", "empty");
    expect(
      screen.getByText(
        /No consolidated memory yet — or RECON_MEMORY_ID not configured/,
      ),
    ).toHaveAttribute("data-kind", "empty");
    expect(
      screen.queryByRole("checkbox", { name: /memory record/ }),
    ).toBeNull();
  });

  it("leaves the decisions table standing when the memory reads fail", async () => {
    api.getMemoryRecords.mockRejectedValue(new Error("recon API error 500"));
    api.getMemoryStrategy.mockRejectedValue(new Error("recon API error 500"));
    render(<LessonsPage />);

    // The ledger half renders as usual.
    expect(await screen.findByText("IT-1")).toBeTruthy();
    expect(
      screen.getByText("Facility mapping must be fixed first."),
    ).toBeTruthy();
    // The strategy failure is named in its own dashed box; the records degrade to an empty state
    // without a word about why — advisory context does not announce its failures here.
    expect(
      await screen.findByText(
        /Could not read the memory strategy — Error: recon API error 500/,
      ),
    ).toHaveAttribute("data-kind", "error");
    expect(await screen.findByText(/No consolidated memory yet/)).toBeTruthy();
    expect(screen.queryByText(/Could not load records/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: /Select memory record/ }),
    ).toBeNull();
  });
});

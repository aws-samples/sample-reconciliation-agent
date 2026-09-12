/**
 * The memory manager beside the assistant.
 *
 * It reloads after every assistant turn without remounting, so what it must get right is state that
 * outlives a reload: an error from one failed fetch has to clear when the next succeeds, and the
 * outcome of a delete or a save has to sit beside the control that ran it, in a colour that says which
 * way it went — a refused delete drawn like a confirmation is a record the parser still recalls.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStrategyResponse } from "@/lib/pipelineApi";
import type { MemoryRecord } from "@/lib/pipeline/types";

const api = {
  addMemory: vi.fn(),
  deleteMemory: vi.fn(),
  getMemoryStrategy: vi.fn(),
  listMemory: vi.fn(),
  listProposals: vi.fn(),
};
vi.mock("@/lib/pipelineApi", () => ({
  addMemory: (...a: unknown[]) => api.addMemory(...a),
  deleteMemory: (...a: unknown[]) => api.deleteMemory(...a),
  getMemoryStrategy: (...a: unknown[]) => api.getMemoryStrategy(...a),
  listMemory: (...a: unknown[]) => api.listMemory(...a),
  listProposals: (...a: unknown[]) => api.listProposals(...a),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { MemoryManagerPanel } from "@/components/pipeline/MemoryManagerPanel";

const RECORD: MemoryRecord = {
  id: "mem-1",
  namespace: "deal-pipeline/edge-cases/deal-desk",
  content: "Project-finance term loans are First Lien in the OMS even when the notice says Senior Secured.",
  createdAt: "2026-08-05T14:00:00Z",
};

const STRATEGY: MemoryStrategyResponse = {
  configured: true,
  memoryStatus: "ACTIVE",
  strategies: [
    {
      id: "st-1",
      name: "edge_cases",
      description: null,
      type: "CUSTOM",
      configurationType: "SEMANTIC_OVERRIDE",
      status: "ACTIVE",
      namespaces: ["deal-pipeline/edge-cases/{actorId}"],
      extraction: null,
      consolidation: null,
    },
  ],
};

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.listMemory.mockResolvedValue([RECORD]);
  api.getMemoryStrategy.mockResolvedValue(STRATEGY);
  api.listProposals.mockResolvedValue([]);
});

describe("MemoryManagerPanel", () => {
  it("clears a stale strategy error once a reload reads the strategy", async () => {
    api.getMemoryStrategy
      .mockRejectedValueOnce(new Error("pipeline API error 500"))
      .mockResolvedValueOnce(STRATEGY);
    render(<MemoryManagerPanel isAdmin={false} />);

    expect(
      await screen.findByText("Could not read the memory strategy — Error: pipeline API error 500"),
    ).toBeTruthy();
    expect(screen.queryByText("edge_cases")).toBeNull();

    // Refresh runs the same `load` the parent's refreshToken does; the panel is not remounted.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("edge_cases")).toBeTruthy();
    expect(screen.queryByText(/Could not read the memory strategy/)).toBeNull();
  });

  it("shows a refused delete beside the records, in the error style, and keeps the record", async () => {
    api.deleteMemory.mockResolvedValue({
      deleted: [],
      failed: [{ id: "mem-1", error: "AccessDeniedException" }],
    });
    render(<MemoryManagerPanel isAdmin />);

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select memory record mem-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));

    const records = screen.getByTestId("memory-records");
    const reason = await within(records).findByRole("alert");
    expect(reason).toHaveTextContent("Not deleted — mem-1: AccessDeniedException");
    expect(reason).toHaveAttribute("data-tone", "error");
    expect(reason.style.color).toContain("--rc-red");
    // The record the service refused is still listed and still selected, so the list stays truthful.
    expect(within(records).getByText(RECORD.content)).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select memory record mem-1" })).toBeChecked();
    // And nothing about it appears in the "Add a rule" slot.
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("tells a failed save apart from a successful one", async () => {
    api.addMemory
      .mockRejectedValueOnce(
        new Error('this endpoint requires membership of the "deal-desk-admins" group'),
      )
      .mockResolvedValueOnce(undefined);
    render(<MemoryManagerPanel isAdmin={false} />);

    const box = await screen.findByRole("textbox", { name: "New memory rule" });
    fireEvent.change(box, { target: { value: "Add-on deals carry New Money equal to Issue Size." } });
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveAttribute("data-tone", "error");
    expect(failure).toHaveTextContent(/requires membership of the "deal-desk-admins" group/);
    expect(failure.style.color).toContain("--rc-red");
    expect(failure.style.color).not.toContain("--rc-cyan");

    // The text is still in the box after a failure, so the same click retries it.
    fireEvent.click(screen.getByRole("button", { name: "Save to memory" }));
    const success = await screen.findByRole("status");
    expect(success).toHaveAttribute("data-tone", "success");
    expect(success).toHaveTextContent(/^Saved\./);
    expect(success.style.color).toContain("--rc-cyan");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lists the records under a select-all header, with Refresh and the proposals link, for an admin", async () => {
    render(<MemoryManagerPanel isAdmin />);

    expect(await screen.findByText(RECORD.content)).toBeTruthy();
    expect(screen.getByText("Consolidated records")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select all memory records" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Select memory record mem-1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Proposals" })).toBeTruthy();
  });

  it("names the memory variable when there is nothing to show, in one line rather than a box", async () => {
    api.listMemory.mockResolvedValue([]);
    api.getMemoryStrategy.mockResolvedValue({ configured: false, memoryStatus: null, strategies: [] });
    render(<MemoryManagerPanel isAdmin={false} />);

    expect(
      await screen.findByText("No consolidated memory yet — or KNOWLEDGE_MEMORY_ID not configured."),
    ).toBeTruthy();
    // The panel's notes are inline here — a sidebar has no room for a dashed box per note.
    const note = screen.getByText("KNOWLEDGE_MEMORY_ID not configured — no strategy to show.");
    expect(note.tagName).toBe("P");
    expect(note).not.toHaveAttribute("data-kind");
  });
});

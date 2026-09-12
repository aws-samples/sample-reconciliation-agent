/**
 * The pipeline Config tab's "Use console default" affordance.
 *
 * The console may name a default model (`/console/settings`, Defaults); the route reports it as
 * `consoleDefaultModelId`. The button fills the two controls so the composed id equals it exactly,
 * and nothing is written until the existing Apply — the parser reads this app's parameter, not the
 * console's. Without the field there is nothing to offer, and a non-admin sees the value but no button.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = { getConfig: vi.fn(), saveConfig: vi.fn() };
vi.mock("@/lib/pipelineApi", () => ({
  getConfig: (...a: unknown[]) => api.getConfig(...a),
  saveConfig: (...a: unknown[]) => api.saveConfig(...a),
}));
let isAdmin = true;
vi.mock("@/hooks/useAppSubject", () => ({
  useAppSubject: () => ({ subject: "sub-1", groups: [], isAdmin }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ConfigPage from "@/app/pipeline/config/page";

beforeEach(() => {
  api.getConfig.mockReset();
  api.saveConfig.mockReset();
  isAdmin = true;
});

describe("pipeline Config tab — console default", () => {
  it("fills the controls from the console default and leaves the write to Apply", async () => {
    api.getConfig.mockResolvedValue({
      modelId: "us.anthropic.claude-sonnet-5",
      consoleDefaultModelId: "global.anthropic.claude-opus-5",
    });
    api.saveConfig.mockResolvedValue({ modelId: "global.anthropic.claude-opus-5" });
    render(<ConfigPage />);

    const block = await screen.findByTestId("console-default-model");
    expect(block).toHaveTextContent("Console default: global.anthropic.claude-opus-5");
    // Nothing composed to that id yet, so no Apply is offered.
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Use console default" }));
    // The composed id now equals the console default — both controls moved, not one. It appears once
    // in the "Console default" line and once as the pending id OUTSIDE that line.
    const occurrences = screen.getAllByText("global.anthropic.claude-opus-5");
    expect(occurrences.some((el) => !block.contains(el))).toBe(true);
    expect(api.saveConfig).not.toHaveBeenCalled();
    // Filled, so the button has nothing more to do.
    expect(screen.getByRole("button", { name: "Use console default" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(api.saveConfig).toHaveBeenCalledWith("global.anthropic.claude-opus-5"));
  });

  it("offers nothing when the route reports no console default", async () => {
    api.getConfig.mockResolvedValue({ modelId: "us.anthropic.claude-sonnet-5" });
    render(<ConfigPage />);
    await screen.findByRole("button", { name: "Opus 5" });
    expect(screen.queryByTestId("console-default-model")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use console default" })).toBeNull();
  });

  it("shows the value but no button to a viewer outside the admin group", async () => {
    isAdmin = false;
    api.getConfig.mockResolvedValue({
      modelId: "us.anthropic.claude-sonnet-5",
      consoleDefaultModelId: "us.anthropic.claude-fable-5-1",
    });
    render(<ConfigPage />);
    expect(await screen.findByTestId("console-default-model")).toHaveTextContent("us.anthropic.claude-fable-5-1");
    expect(screen.queryByRole("button", { name: "Use console default" })).toBeNull();
  });

  it("withholds Apply when the console default is not an accepted id here", async () => {
    api.getConfig.mockResolvedValue({
      modelId: "us.anthropic.claude-sonnet-5",
      modelIds: ["us.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-5"],
      consoleDefaultModelId: "global.anthropic.claude-opus-5",
    });
    render(<ConfigPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Use console default" }));
    // The existing guard: a composed id outside the route's list is shown but cannot be applied.
    expect(screen.getByText("not an accepted combination")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });
});

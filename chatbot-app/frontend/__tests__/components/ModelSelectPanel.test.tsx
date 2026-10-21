/**
 * `ModelSelectPanel`, the model row both Config tabs mount.
 *
 * Driven through the same four states the recon Config page drove when the row was inline, and which
 * `ConfigPage.model.test.tsx` still pins through the page: the resolved id is on screen; Apply is
 * withheld while the selection is clean or the pair is outside what the server accepts; a rejected pair
 * says "not an accepted combination"; and the two lines under the controls — no recorded selection, in
 * the caller's words, and a stored id no preset composes — appear only in their state. Plus the two
 * options recon does not use: the console-default fill and read-only, whose defaults are recon's.
 *
 * No snapshots: every assertion names the behaviour it protects, so a class rename cannot fail it and
 * a real regression cannot hide in an accepted diff.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ModelSelectPanel } from "@/components/app-ui/ModelSelectPanel";

const MODEL_IDS = [
  "us.anthropic.claude-opus-5",
  "global.anthropic.claude-opus-5",
  "us.anthropic.claude-sonnet-5",
  "global.anthropic.claude-sonnet-5",
  "us.anthropic.claude-fable-5-1",
  "global.anthropic.claude-fable-5-1",
];

type Props = Parameters<typeof ModelSelectPanel>[0];

/** Render with recon's defaults: loaded, a stored Sonnet/US selection, the full allowlist. */
function show(over: Partial<Props> = {}) {
  const onApply = vi.fn();
  const props: Props = {
    value: "us.anthropic.claude-sonnet-5",
    loaded: true,
    allowed: MODEL_IDS,
    deployedDefault: "each backend is using the model it was deployed with.",
    onApply,
    description: "Which model the agent invokes.",
    ...over,
  };
  const utils = render(<ModelSelectPanel {...props} />);
  return { ...utils, onApply, props };
}

const button = (name: string) => screen.getByRole("button", { name });
const apply = () => screen.queryByRole("button", { name: "Apply" });

describe("ModelSelectPanel — the resolved id", () => {
  it("pre-selects the controls from the stored id and shows the id it composes", () => {
    show();

    expect(button("Sonnet 5")).toHaveAttribute("aria-pressed", "true");
    expect(button("US")).toHaveAttribute("aria-pressed", "true");
    expect(button("Opus 5")).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText("us.anthropic.claude-sonnet-5"),
    ).toBeInTheDocument();
  });

  it("recomposes the id as either control changes, and writes nothing until Apply", () => {
    const { onApply } = show();

    fireEvent.click(button("Opus 5"));
    expect(screen.getByText("us.anthropic.claude-opus-5")).toBeInTheDocument();
    fireEvent.click(button("Global"));
    expect(
      screen.getByText("global.anthropic.claude-opus-5"),
    ).toBeInTheDocument();
    // An operator mid-way between two choices has not made one, and for the US/global pair the
    // intermediate state is a data-residency change.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(button("Apply"));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith("global.anthropic.claude-opus-5");
  });

  it("labels the global endpoint as data residency, not as a faster tier", () => {
    show();
    expect(button("Global").getAttribute("title")).toMatch(/outside the US/i);
  });

  it("holds the controls disabled and names no id until the config has arrived", () => {
    show({ loaded: false, value: null, allowed: [] });

    expect(button("Opus 5")).toBeDisabled();
    expect(button("Global")).toBeDisabled();
    expect(apply()).toBeNull();
    expect(screen.getByText("loading…")).toBeInTheDocument();
    // Neither a guessed id nor the "no selection" line: nothing is known yet.
    expect(screen.queryByText("us.anthropic.claude-sonnet-5")).toBeNull();
    expect(screen.queryByText(/No selection recorded/)).toBeNull();
  });
});

describe("ModelSelectPanel — when Apply is offered", () => {
  it("offers no Apply while the selection is clean", () => {
    show();
    expect(apply()).toBeNull();
  });

  it("withdraws Apply again once the pick is back on the stored id", () => {
    show();
    fireEvent.click(button("Opus 5"));
    expect(apply()).not.toBeNull();
    fireEvent.click(button("Sonnet 5"));
    expect(apply()).toBeNull();
  });

  it("withdraws Apply once the page reports the applied id as saved", () => {
    const { rerender, props } = show();
    fireEvent.click(button("Opus 5"));
    expect(apply()).not.toBeNull();

    rerender(
      <ModelSelectPanel {...props} value="us.anthropic.claude-opus-5" />,
    );

    expect(apply()).toBeNull();
    expect(screen.getByText("us.anthropic.claude-opus-5")).toBeInTheDocument();
  });

  it("keeps Apply on screen but disabled while the page is busy, with the controls", () => {
    const { rerender, props } = show();
    fireEvent.click(button("Opus 5"));

    rerender(<ModelSelectPanel {...props} busy />);

    // Visible and disabled, not withdrawn: the operator can see their pick is being written.
    expect(apply()).toBeDisabled();
    expect(button("Sonnet 5")).toBeDisabled();
    expect(button("Global")).toBeDisabled();
  });

  it("refuses Apply for a pair the server did not list, and says so", () => {
    const { onApply } = show({
      allowed: MODEL_IDS.filter((m) => m !== "global.anthropic.claude-opus-5"),
    });
    fireEvent.click(button("Opus 5"));
    fireEvent.click(button("Global"));

    // The composed id still shows — the operator must see what they built — but it cannot be sent.
    expect(
      screen.getByText("global.anthropic.claude-opus-5"),
    ).toBeInTheDocument();
    expect(apply()).toBeNull();
    expect(screen.getByText("not an accepted combination")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("offers every pair when the server reported no allowlist", () => {
    show({ allowed: [] });
    fireEvent.click(button("Fable 5.1"));
    expect(apply()).not.toBeNull();
    expect(screen.queryByText("not an accepted combination")).toBeNull();
  });
});

describe("ModelSelectPanel — the lines under the controls", () => {
  it("reports no recorded selection in the caller's words, and nothing else", () => {
    show({ value: null });

    expect(
      screen.getByText(
        "No selection recorded — each backend is using the model it was deployed with.",
      ),
    ).toBeInTheDocument();
    // The controls still show the deployed default pair, but that is a starting point, not a claim —
    // and because nothing is recorded, recording that pair explicitly is a real change: Apply is offered.
    expect(
      screen.getByText("us.anthropic.claude-sonnet-5"),
    ).toBeInTheDocument();
    expect(apply()).not.toBeNull();
    expect(screen.queryByText(/is not one of the presets/)).toBeNull();
  });

  it("says nothing about a missing selection once one is stored", () => {
    show();
    expect(screen.queryByText(/No selection recorded/)).toBeNull();
  });

  it("flags a stored id no preset composes, without pretending a preset is selected", () => {
    show({
      value: "us.anthropic.claude-haiku-4",
      allowed: [...MODEL_IDS, "us.anthropic.claude-haiku-4"],
    });

    expect(
      screen.getByText(
        "The stored id, us.anthropic.claude-haiku-4, is not one of the presets above; applying a preset replaces it.",
      ),
    ).toBeInTheDocument();
    // The id itself is the resolved id on screen; no family button lights up for it.
    expect(screen.getByText("us.anthropic.claude-haiku-4")).toBeInTheDocument();
    for (const family of ["Opus 5", "Sonnet 5", "Fable 5.1"]) {
      expect(button(family)).toHaveAttribute("aria-pressed", "false");
    }
    // Clean, so nothing to apply until a preset is picked.
    expect(apply()).toBeNull();
    fireEvent.click(button("Opus 5"));
    expect(screen.getByText("us.anthropic.claude-opus-5")).toBeInTheDocument();
    expect(apply()).not.toBeNull();
  });

  it("shows the load error in place of the controls", () => {
    show({
      error: "config read failed: AccessDeniedException",
      loaded: false,
      value: null,
    });

    expect(
      screen.getByText(/Failed to load — config read failed/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Opus 5" })).toBeNull();
  });
});

describe("ModelSelectPanel — options recon does not use", () => {
  it("offers no console-default line unless one is given", () => {
    show();
    expect(screen.queryByTestId("console-default-model")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Use console default" }),
    ).toBeNull();
  });

  it("fills both controls from the console default and leaves the write to Apply", () => {
    const { onApply } = show({
      consoleDefault: "global.anthropic.claude-opus-5",
    });

    const block = screen.getByTestId("console-default-model");
    expect(block).toHaveTextContent(
      "Console default: global.anthropic.claude-opus-5",
    );
    expect(apply()).toBeNull();

    fireEvent.click(button("Use console default"));
    // Both controls moved: the id appears once in the console-default line and once as the pending id
    // outside it.
    const occurrences = screen.getAllByText("global.anthropic.claude-opus-5");
    expect(occurrences.some((el) => !block.contains(el))).toBe(true);
    expect(button("Opus 5")).toHaveAttribute("aria-pressed", "true");
    expect(button("Global")).toHaveAttribute("aria-pressed", "true");
    expect(onApply).not.toHaveBeenCalled();
    // Filled, so the button has nothing more to do.
    expect(button("Use console default")).toBeDisabled();

    fireEvent.click(button("Apply"));
    expect(onApply).toHaveBeenCalledWith("global.anthropic.claude-opus-5");
  });

  it("read-only: disables the controls and withholds Apply and the console-default fill", () => {
    show({ readOnly: true, consoleDefault: "us.anthropic.claude-fable-5-1" });

    expect(button("Opus 5")).toBeDisabled();
    expect(button("Global")).toBeDisabled();
    expect(apply()).toBeNull();
    // The value is still shown to a viewer who may not change it.
    expect(screen.getByTestId("console-default-model")).toHaveTextContent(
      "us.anthropic.claude-fable-5-1",
    );
    expect(
      screen.queryByRole("button", { name: "Use console default" }),
    ).toBeNull();
  });
});

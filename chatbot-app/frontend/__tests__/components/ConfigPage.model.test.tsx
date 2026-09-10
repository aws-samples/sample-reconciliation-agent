/**
 * The Config tab's Tier-2 model row.
 *
 * The model id is selectable here rather than deploy-time only, which is what makes it consistent with
 * the agent BACKEND switch sitting one click away on the same panel. Three things about the control are
 * load-bearing and are what this file pins:
 *
 *   1. the two selectors COMPOSE into one id, and that id is visible before anything is written —
 *      half the available pairs are a data-residency change, and a click-by-click save would write
 *      intermediate pairs nobody chose;
 *   2. `global.` is labelled as data residency, not as a faster tier, because the id itself says
 *      nothing about where the inference runs;
 *   3. no recorded selection is reported as such, rather than as whichever id the page guessed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from "@testing-library/react";

const getConfig = vi.fn();
const saveConfig = vi.fn();
const getLambdaSource = vi.fn();
const getHarnessInfo = vi.fn();

// Every child panel on this page (contacts, templates, workflow types) reads through the same module,
// so one mock keeps the page renderable without standing up four more fixtures.
vi.mock("@/lib/reconApi", () => ({
  getConfig,
  saveConfig,
  getLambdaSource,
  getHarnessInfo,
  listContacts: vi.fn().mockResolvedValue([]),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deactivateContact: vi.fn(),
  listEmailTemplates: vi.fn().mockResolvedValue([]),
  createEmailTemplate: vi.fn(),
  updateEmailTemplate: vi.fn(),
  deactivateEmailTemplate: vi.fn(),
  listWorkflowTypes: vi.fn().mockResolvedValue([]),
  createWorkflowType: vi.fn(),
  updateWorkflowType: vi.fn(),
  deactivateWorkflowType: vi.fn(),
}));

const ConfigPage = (await import("@/app/recon/config/page")).default;

const MODEL_IDS = [
  "us.anthropic.claude-opus-5",
  "global.anthropic.claude-opus-5",
  "us.anthropic.claude-sonnet-5",
  "global.anthropic.claude-sonnet-5",
  "us.anthropic.claude-fable-5-1",
  "global.anthropic.claude-fable-5-1",
];

/** Click and flush. Awaited inside `act` so a save's state updates land before the assertions. */
async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}

/** Render the page with one config payload and wait for the model row to settle. */
async function show(over: Record<string, unknown> = {}) {
  getConfig.mockResolvedValue({
    tier1Enabled: true,
    autoResolveThreshold: 0.85,
    commentRequirement: "optional",
    agentBackend: "runtime",
    agentModelId: "us.anthropic.claude-sonnet-5",
    agentModelIds: MODEL_IDS,
    ...over,
  });
  render(<ConfigPage />);
  await screen.findByText("Model");
}

beforeEach(() => {
  vi.clearAllMocks();
  getLambdaSource.mockResolvedValue([]);
  getHarnessInfo.mockResolvedValue({ configured: false, name: "none" });
});

describe("Config tab — Tier-2 model selection", () => {
  it("offers every family and both endpoints", async () => {
    await show();

    expect(screen.getByRole("button", { name: "Opus 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sonnet 5" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fable 5.1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "US" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Global" })).toBeTruthy();
    // The stored selection pre-selects the controls, and the composed id is on screen unasked.
    expect(screen.getByText("us.anthropic.claude-sonnet-5")).toBeTruthy();
  });

  it("shows the composed id and writes nothing until Apply", async () => {
    await show();
    await click(screen.getByRole("button", { name: "Opus 5" }));

    // Composed and displayed. Nothing written: an operator mid-way between two choices has not made
    // one, and for the global/US pair the intermediate state is a data-residency change.
    expect(screen.getByText("us.anthropic.claude-opus-5")).toBeTruthy();
    expect(saveConfig).not.toHaveBeenCalled();

    await click(screen.getByRole("button", { name: "Apply" }));

    expect(saveConfig).toHaveBeenCalledWith({
      agentModelId: "us.anthropic.claude-opus-5",
    });
  });

  it("composes the endpoint into the id too", async () => {
    await show();
    await click(screen.getByRole("button", { name: "Fable 5.1" }));
    await click(screen.getByRole("button", { name: "Global" }));
    await click(screen.getByRole("button", { name: "Apply" }));

    expect(saveConfig).toHaveBeenCalledWith({
      agentModelId: "global.anthropic.claude-fable-5-1",
    });
    // And the CONFIRMATION repeats where the inference may now run — matched on the whole sentence,
    // because the panel's standing description mentions the same fact and a loose regex would pass on
    // that copy alone even if the confirmation never mentioned residency.
    await waitFor(() =>
      expect(
        screen.getByText(
          /Tier-2 now invokes global\.anthropic\.claude-fable-5-1.*outside the US/i,
        ),
      ).toBeTruthy(),
    );
  });

  it("labels the global endpoint as data residency, not as a faster tier", async () => {
    await show();

    // The whole reason the endpoint is a separate control: `global.` is invisible in the id and reads
    // like a performance setting, so the panel has to say what it actually changes.
    expect(screen.getByText(/data-residency/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Global" }).getAttribute("title"),
    ).toMatch(/outside the US/i);
  });

  it("offers no Apply button when nothing changed", async () => {
    await show();
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("reports no recorded selection instead of naming a guess", async () => {
    // A fresh environment. The default lives in each BACKEND's environment, which this page cannot
    // read, so claiming an id here would be an assertion it has no basis for.
    await show({ agentModelId: null });

    expect(screen.getByText(/No selection recorded/i)).toBeTruthy();
  });

  it("says the harness config version overrides the selection, on the harness backend only", async () => {
    // A deployed config version pins its own model, deliberately — that is how a scored configuration
    // in the Evals tab stays reproducible. Switching model and watching the harness ignore it reads as
    // the control being broken unless the panel says so.
    await show({ agentBackend: "harness" });
    expect(screen.getByText(/pins its own model/i)).toBeTruthy();
  });

  it("does not raise the override caveat on the runtime backend", async () => {
    // There is no config-version pin on that path, so the caveat would be noise that makes the
    // selection look less trustworthy than it is.
    await show({ agentBackend: "runtime" });
    expect(screen.queryByText(/pins its own model/i)).toBeNull();
  });

  it("refuses to offer Apply for a pair the server would reject", async () => {
    // The BFF allowlist and the Python one are hand-maintained copies of each other, and this page's
    // family list is a third. A pair missing from what the server said it accepts must surface here
    // rather than as a 400 after the click.
    await show({
      agentModelIds: MODEL_IDS.filter(
        (m) => m !== "global.anthropic.claude-opus-5",
      ),
    });
    await click(screen.getByRole("button", { name: "Opus 5" }));
    await click(screen.getByRole("button", { name: "Global" }));

    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByText(/not an accepted combination/i)).toBeTruthy();
    expect(saveConfig).not.toHaveBeenCalled();
  });
});

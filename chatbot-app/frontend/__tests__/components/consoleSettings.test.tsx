/**
 * The console Settings screen.
 *
 * Pinned: a non-admin lands on Preferences and sees the admin sections read-only with a note naming
 * CONSOLE_ADMIN_GROUP, and the settings body is never requested for them; an admin sees each field's
 * resolved value with a chip saying where it came from, a save sends ONLY what changed ("" to clear)
 * and the chips refresh from the server's answer; an admin without the stored layer sees the fields but
 * cannot edit them, with a note naming CONSOLE_SETTINGS_PREFIX; the Applications switch warns that
 * disabling hides the app for everyone; the Defaults presets compose into the id field; the Users
 * section shows the viewer and, for admins, answers an access check as a table; and Preferences write
 * on change when there is a row to write, and fall back to the browser (with a note) when there is not.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fakeResponse } from "../helpers/http";

import type { ConsoleSettings } from "@/lib/console/types";
import { resetViewerCache } from "@/lib/shell/viewer";

let search = "";
vi.mock("next/navigation", () => ({
  usePathname: () => "/console/settings",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: async () => ({}) }));
vi.mock("@/lib/reauth", () => ({ reauthenticate: vi.fn().mockResolvedValue(true) }));
const setTheme = vi.fn();
let browserTheme = "system";
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: browserTheme, setTheme }) }));
const api = {
  getConsoleSettings: vi.fn(),
  updateConsoleSettings: vi.fn(),
  accessCheck: vi.fn(),
  putPreferences: vi.fn(),
  getPreferences: vi.fn(),
};
vi.mock("@/lib/consoleApi", () => ({
  getConsoleSettings: (...a: unknown[]) => api.getConsoleSettings(...a),
  updateConsoleSettings: (...a: unknown[]) => api.updateConsoleSettings(...a),
  accessCheck: (...a: unknown[]) => api.accessCheck(...a),
  putPreferences: (...a: unknown[]) => api.putPreferences(...a),
  getPreferences: (...a: unknown[]) => api.getPreferences(...a),
}));

import ConsoleSettingsPage from "@/app/console/settings/page";
import { SettingsScreen } from "@/components/console/SettingsScreen";

const storage = window.localStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

/** A `/api/me` body. Admin and configured by default; tests narrow it. */
function me(over: Record<string, unknown> = {}) {
  return {
    subject: "ana.ferreira",
    groups: ["console-admins", "recon-users"],
    mode: "okta",
    apps: { recon: { access: true, admin: true }, pipeline: { access: true, admin: false } },
    console: { admin: true, configured: true, organizationLabel: "Meridian Ops" },
    preferences: {},
    ...over,
  };
}

function serveMe(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(200, body)));
}

/** The settings body: one of each source, so every chip variant is on screen. */
function settings(over: Partial<ConsoleSettings> = {}): ConsoleSettings {
  return {
    configured: true,
    prefix: "/recon-dev/console",
    access: {
      recon: {
        accessGroup: { value: "recon-users", source: "env", envName: "RECON_ACCESS_GROUP" },
        adminGroup: { value: "", source: "default", envName: "RECON_ADMIN_GROUP" },
      },
      pipeline: {
        accessGroup: { value: "deal-desk", source: "stored", envName: "PIPELINE_ACCESS_GROUP" },
        adminGroup: { value: "deal-desk-admins", source: "env", envName: "PIPELINE_ADMIN_GROUP" },
      },
    },
    apps: { pipeline: { enabled: { value: "true", source: "env", envName: "PIPELINE_ENABLED" } } },
    defaults: {
      modelId: { value: "", source: "default", envName: "CONSOLE_DEFAULT_MODEL_ID" },
      organizationLabel: { value: "Meridian Ops", source: "stored", envName: "CONSOLE_ORGANIZATION_LABEL" },
    },
    envOnly: { requireAccessGroups: true, anonymousMode: false, consoleAdminGroup: "console-admins" },
    updatedAt: "2026-09-10T09:00:00Z",
    updatedBy: "ops.lead",
    ...over,
  };
}

const group = (name: string) => screen.getByRole("group", { name });

beforeEach(() => {
  resetViewerCache();
  search = "";
  browserTheme = "system";
  setTheme.mockReset();
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.getConsoleSettings.mockResolvedValue(settings());
  api.putPreferences.mockImplementation(async (p: unknown) => p);
});

describe("Settings screen for a viewer who is not a console admin", () => {
  const nonAdmin = () =>
    me({
      groups: ["recon-users"],
      apps: { recon: { access: true, admin: false }, pipeline: { access: true, admin: false } },
      console: { admin: false, configured: true, organizationLabel: "" },
    });

  it("lands on Preferences and never asks for the settings body", async () => {
    serveMe(nonAdmin());
    render(<SettingsScreen tabParam={null} />);
    expect(await screen.findByRole("heading", { name: "Console settings" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Preferences" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("Theme")).toBeInTheDocument();
    expect(api.getConsoleSettings).not.toHaveBeenCalled();
  });

  it("shows the Access section read-only, naming the console admin group variable", async () => {
    serveMe(nonAdmin());
    render(<SettingsScreen tabParam="access" />);
    const note = await screen.findByTestId("read-only-note");
    expect(note).toHaveTextContent("CONSOLE_ADMIN_GROUP");
    expect(note).toHaveTextContent("ana.ferreira");
    // The structure is public (which variables exist); the values are not.
    expect(screen.getByText("RECON_ACCESS_GROUP")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /Save/ })).toBeNull();
    expect(api.getConsoleSettings).not.toHaveBeenCalled();
  });

  it("shows the viewer on Users without the access checker", async () => {
    serveMe(nonAdmin());
    render(<SettingsScreen tabParam="users" />);
    const you = await screen.findByTestId("current-viewer");
    expect(you).toHaveTextContent("ana.ferreira");
    expect(screen.getByTestId("viewer-groups")).toHaveTextContent("recon-users");
    const table = screen.getByTestId("viewer-access");
    const recon = within(table).getByRole("row", { name: /Trade Reconciliation/ });
    expect(within(recon).getAllByText("yes")).toHaveLength(1);
    expect(within(recon).getAllByText("no")).toHaveLength(1);
    expect(screen.queryByTestId("access-checker")).toBeNull();
    // The env-only switches are named even though their values are admins-only.
    const envOnly = screen.getByTestId("env-only");
    for (const name of ["REQUIRE_ACCESS_GROUPS", "ALLOW_ANONYMOUS_API", "CONSOLE_ADMIN_GROUP"]) {
      expect(envOnly).toHaveTextContent(name);
    }
  });
});

describe("Access section for a console admin", () => {
  it("shows each resolved value with its source chip", async () => {
    serveMe(me());
    render(<SettingsScreen tabParam="access" />);
    expect(await screen.findByRole("link", { name: "Access" })).toHaveAttribute("aria-current", "page");
    const recon = await screen.findByRole("group", { name: "Trade Reconciliation" });
    expect(within(recon).getByLabelText("Access group")).toHaveValue("recon-users");
    expect(screen.getByTestId("recon-access-group-source")).toHaveAttribute("data-source", "env");
    expect(screen.getByTestId("recon-access-group-source")).toHaveAccessibleName(
      "From the environment variable RECON_ACCESS_GROUP",
    );
    expect(screen.getByTestId("recon-admin-group-source")).toHaveAttribute("data-source", "default");
    expect(screen.getByTestId("pipeline-access-group-source")).toHaveAttribute("data-source", "stored");
    expect(within(group("Deal Pipeline")).getByLabelText("Access group")).toHaveValue("deal-desk");
    expect(screen.getByTestId("updated-line")).toHaveTextContent("ops.lead");
    // REQUIRE_ACCESS_GROUPS is true on this deployment, so the note says a blank group denies.
    expect(screen.getByText(/denies/)).toBeInTheDocument();
    expect(screen.queryByTestId("read-only-note")).toBeNull();
  });

  it("saves only the changed fields and refreshes the chips from the answer", async () => {
    serveMe(me());
    const refreshed = settings();
    refreshed.access.recon.accessGroup = { value: "recon-analysts", source: "stored", envName: "RECON_ACCESS_GROUP" };
    refreshed.access.pipeline.accessGroup = { value: "", source: "default", envName: "PIPELINE_ACCESS_GROUP" };
    api.updateConsoleSettings.mockResolvedValue(refreshed);
    render(<SettingsScreen tabParam="access" />);

    const recon = await screen.findByRole("group", { name: "Trade Reconciliation" });
    const save = screen.getByRole("button", { name: "Save access groups" });
    expect(save).toBeDisabled();

    fireEvent.change(within(recon).getByLabelText("Access group"), { target: { value: "recon-analysts" } });
    // Clearing sends "" — the instruction to drop the stored value and fall back to the environment.
    fireEvent.change(within(group("Deal Pipeline")).getByLabelText("Access group"), { target: { value: "" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.updateConsoleSettings).toHaveBeenCalledTimes(1));
    // Untouched fields — the env admin group, the default recon admin group — are absent from the body.
    expect(api.updateConsoleSettings).toHaveBeenCalledWith({
      access: { recon: { accessGroup: "recon-analysts" }, pipeline: { accessGroup: "" } },
    });
    expect(await screen.findByTestId("access-outcome")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("recon-access-group-source")).toHaveAttribute("data-source", "stored");
    expect(screen.getByTestId("pipeline-access-group-source")).toHaveAttribute("data-source", "default");
    expect(within(group("Deal Pipeline")).getByLabelText("Access group")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save access groups" })).toBeDisabled();
  });

  it("refuses an invalid group name before the round trip", async () => {
    serveMe(me());
    render(<SettingsScreen tabParam="access" />);
    const recon = await screen.findByRole("group", { name: "Trade Reconciliation" });
    const input = within(recon).getByLabelText("Admin group");
    fireEvent.change(input, { target: { value: "bad;name" } });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(within(recon).getByRole("alert")).toHaveTextContent(/only/);
    expect(screen.getByRole("button", { name: "Save access groups" })).toBeDisabled();
    expect(api.updateConsoleSettings).not.toHaveBeenCalled();
  });

  it("shows the server's refusal as an error and keeps the edit", async () => {
    serveMe(me());
    api.updateConsoleSettings.mockRejectedValue(new Error("console settings require the console-admins group"));
    render(<SettingsScreen tabParam="access" />);
    const recon = await screen.findByRole("group", { name: "Trade Reconciliation" });
    fireEvent.change(within(recon).getByLabelText("Admin group"), { target: { value: "recon-admins" } });
    fireEvent.click(screen.getByRole("button", { name: "Save access groups" }));
    const outcome = await screen.findByTestId("access-outcome");
    expect(outcome).toHaveAttribute("data-tone", "error");
    expect(outcome).toHaveTextContent("console settings require the console-admins group");
    expect(within(recon).getByLabelText("Admin group")).toHaveValue("recon-admins");
  });

  it("names the failure and offers a retry when the settings cannot be loaded", async () => {
    serveMe(me());
    api.getConsoleSettings
      .mockRejectedValueOnce(new Error("console API error 502"))
      .mockResolvedValueOnce(settings());
    render(<SettingsScreen tabParam="access" />);
    expect(await screen.findByTestId("console-settings-error")).toHaveTextContent("console API error 502");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("group", { name: "Trade Reconciliation" })).toBeInTheDocument();
    expect(api.getConsoleSettings).toHaveBeenCalledTimes(2);
  });
});

describe("Settings screen for an admin without the stored layer", () => {
  it("shows the values read-only with a note naming CONSOLE_SETTINGS_PREFIX", async () => {
    serveMe(me({ console: { admin: true, configured: false, organizationLabel: "" } }));
    api.getConsoleSettings.mockResolvedValue(settings({ configured: false, prefix: null }));
    render(<SettingsScreen tabParam="access" />);
    const recon = await screen.findByRole("group", { name: "Trade Reconciliation" });
    expect(screen.getByTestId("read-only-note")).toHaveTextContent("CONSOLE_SETTINGS_PREFIX");
    expect(within(recon).getByLabelText("Access group")).toHaveValue("recon-users");
    expect(within(recon).getByLabelText("Access group")).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "Save access groups" })).toBeNull();
  });
});

describe("Applications section", () => {
  it("offers a switch only for apps that have one, warns about disabling, and saves the flip", async () => {
    serveMe(me());
    const refreshed = settings();
    refreshed.apps.pipeline = { enabled: { value: "false", source: "stored", envName: "PIPELINE_ENABLED" } };
    api.updateConsoleSettings.mockResolvedValue(refreshed);
    render(<SettingsScreen tabParam="applications" />);

    expect(await screen.findByTestId("recon-always-enabled")).toHaveTextContent("Always part of the console");
    const pipeline = group("Deal Pipeline");
    const toggle = within(pipeline).getByLabelText("Enabled");
    expect(toggle).toBeChecked();
    expect(screen.getByTestId("pipeline-enabled-source")).toHaveAttribute("data-source", "env");
    expect(screen.getByTestId("pipeline-enabled-warning")).toHaveAttribute("data-tone", "info");

    fireEvent.click(toggle);
    const warning = screen.getByTestId("pipeline-enabled-warning");
    expect(warning).toHaveAttribute("data-tone", "warn");
    expect(warning).toHaveTextContent(/hides Deal Pipeline from every viewer/);

    fireEvent.click(screen.getByRole("button", { name: "Save applications" }));
    await waitFor(() =>
      expect(api.updateConsoleSettings).toHaveBeenCalledWith({ apps: { pipeline: { enabled: false } } }),
    );
    expect(await screen.findByTestId("applications-outcome")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("pipeline-enabled-source")).toHaveAttribute("data-source", "stored");
    expect(within(group("Deal Pipeline")).getByLabelText("Enabled")).not.toBeChecked();
  });
});

describe("Defaults section", () => {
  it("composes the preset buttons into the model id, validates the label, and saves what changed", async () => {
    serveMe(me());
    const refreshed = settings();
    refreshed.defaults.modelId = { value: "global.anthropic.claude-opus-5", source: "stored", envName: "CONSOLE_DEFAULT_MODEL_ID" };
    api.updateConsoleSettings.mockResolvedValue(refreshed);
    render(<SettingsScreen tabParam="defaults" />);

    const modelId = await screen.findByLabelText("Model id");
    expect(modelId).toHaveValue("");
    expect(screen.getByTestId("default-model-id-source")).toHaveAttribute("data-source", "default");
    expect(screen.getByTestId("organization-label-source")).toHaveAttribute("data-source", "stored");
    // The same presets the apps' Config tabs use, labelled as data residency rather than speed.
    expect(screen.getByRole("button", { name: "Global" })).toHaveAttribute("title", expect.stringMatching(/outside the US/));

    fireEvent.click(screen.getByRole("button", { name: "Opus 5" }));
    expect(modelId).toHaveValue("us.anthropic.claude-opus-5");
    fireEvent.click(screen.getByRole("button", { name: "Global" }));
    expect(modelId).toHaveValue("global.anthropic.claude-opus-5");
    expect(screen.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true");

    const label = screen.getByLabelText("Label under the console mark");
    fireEvent.change(label, { target: { value: "x".repeat(61) } });
    expect(label).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save defaults" })).toBeDisabled();
    fireEvent.change(label, { target: { value: "Meridian Ops" } });

    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() =>
      expect(api.updateConsoleSettings).toHaveBeenCalledWith({
        defaults: { modelId: "global.anthropic.claude-opus-5" },
      }),
    );
    expect(await screen.findByTestId("defaults-outcome")).toHaveAttribute("data-tone", "success");
    expect(screen.getByTestId("default-model-id-source")).toHaveAttribute("data-source", "stored");
  });

  it("clears the model id to fall back to the environment", async () => {
    serveMe(me());
    const stored = settings();
    stored.defaults.modelId = { value: "us.anthropic.claude-sonnet-5", source: "stored", envName: "CONSOLE_DEFAULT_MODEL_ID" };
    api.getConsoleSettings.mockResolvedValue(stored);
    api.updateConsoleSettings.mockResolvedValue(settings());
    render(<SettingsScreen tabParam="defaults" />);
    expect(await screen.findByLabelText("Model id")).toHaveValue("us.anthropic.claude-sonnet-5");
    fireEvent.click(screen.getByRole("button", { name: "Clear the default model" }));
    expect(screen.getByLabelText("Model id")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(api.updateConsoleSettings).toHaveBeenCalledWith({ defaults: { modelId: "" } }));
  });
});

describe("Users section for a console admin", () => {
  it("answers an access check as a table and shows the env-only values", async () => {
    serveMe(me());
    api.accessCheck.mockResolvedValue({
      groups: ["deal-desk"],
      apps: { recon: { access: false, admin: false }, pipeline: { access: true, admin: false } },
      consoleAdmin: false,
    });
    render(<SettingsScreen tabParam="users" />);

    const checker = await screen.findByTestId("access-checker");
    fireEvent.change(within(checker).getByLabelText("Groups, comma-separated"), {
      target: { value: " deal-desk, deal-desk ,recon-analysts" },
    });
    fireEvent.click(within(checker).getByRole("button", { name: "Check access" }));
    await waitFor(() => expect(api.accessCheck).toHaveBeenCalledWith(["deal-desk", "recon-analysts"]));

    const table = await screen.findByTestId("access-check-result");
    const recon = within(table).getByRole("row", { name: /Trade Reconciliation/ });
    expect(within(recon).getAllByText("no")).toHaveLength(2);
    const pipeline = within(table).getByRole("row", { name: /Deal Pipeline/ });
    expect(within(pipeline).getByText("yes")).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: /Console settings/ })).toHaveTextContent("no");

    // Values, not just names, once the settings body is in hand.
    await waitFor(() => expect(screen.getByTestId("env-only")).toHaveTextContent("console-admins"));
    expect(screen.getByTestId("env-only")).toHaveTextContent(/true: a blank access group denies/);
  });

  it("shows the server's refusal of a check", async () => {
    serveMe(me());
    api.accessCheck.mockRejectedValue(new Error("groups: at most 128 characters each"));
    render(<SettingsScreen tabParam="users" />);
    const checker = await screen.findByTestId("access-checker");
    fireEvent.click(within(checker).getByRole("button", { name: "Check access" }));
    expect(await screen.findByTestId("access-check-error")).toHaveTextContent("at most 128 characters");
  });
});

describe("Preferences section", () => {
  it("writes the whole row on each change when the console has a stored layer", async () => {
    serveMe(me({ preferences: { railCollapsed: false } }));
    render(<SettingsScreen tabParam="preferences" />);
    const theme = await screen.findByLabelText("Theme");
    expect(screen.queryByTestId("preferences-browser-note")).toBeNull();

    fireEvent.change(theme, { target: { value: "dark" } });
    expect(setTheme).toHaveBeenCalledWith("dark");
    await waitFor(() => expect(api.putPreferences).toHaveBeenCalledWith({ railCollapsed: false, theme: "dark" }));
    expect(await screen.findByTestId("preferences-outcome")).toHaveAttribute("data-tone", "success");

    // The default app select lists only accessible apps and carries the previous fields along.
    const defaultApp = screen.getByLabelText("Default application");
    expect(within(defaultApp).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Show the chooser",
      "Trade Reconciliation",
      "Deal Pipeline",
    ]);
    fireEvent.change(defaultApp, { target: { value: "pipeline" } });
    await waitFor(() =>
      expect(api.putPreferences).toHaveBeenLastCalledWith({ railCollapsed: false, theme: "dark", defaultApp: "pipeline" }),
    );

    // Choosing the chooser again removes the key rather than sending a blank.
    fireEvent.change(screen.getByLabelText("Default application"), { target: { value: "" } });
    await waitFor(() => expect(api.putPreferences).toHaveBeenLastCalledWith({ railCollapsed: false, theme: "dark" }));

    fireEvent.click(screen.getByLabelText("Start with the navigation rail collapsed"));
    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    await waitFor(() => expect(api.putPreferences).toHaveBeenLastCalledWith({ railCollapsed: true, theme: "dark" }));
  });

  it("limits the default app to the apps the viewer may open", async () => {
    serveMe(me({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(<SettingsScreen tabParam="preferences" />);
    const defaultApp = await screen.findByLabelText("Default application");
    expect(within(defaultApp).queryByRole("option", { name: "Deal Pipeline" })).toBeNull();
    // One app: the console opens it directly, so there is nothing to choose.
    expect(defaultApp).toBeDisabled();
  });

  it("falls back to the browser, with a note, when the console has no stored layer", async () => {
    serveMe(me({ console: { admin: false, configured: false, organizationLabel: "" } }));
    render(<SettingsScreen tabParam="preferences" />);
    expect(await screen.findByTestId("preferences-browser-note")).toHaveTextContent("CONSOLE_SETTINGS_PREFIX");
    expect(screen.getByLabelText("Default application")).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    expect(setTheme).toHaveBeenCalledWith("light");
    fireEvent.click(screen.getByLabelText("Start with the navigation rail collapsed"));
    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    expect(api.putPreferences).not.toHaveBeenCalled();
    expect(screen.queryByTestId("preferences-outcome")).toBeNull();
  });

  it("reflects the browser's current theme and rail state when nothing is stored", async () => {
    browserTheme = "dark";
    storage.getItem.mockReturnValue("true");
    serveMe(me());
    render(<SettingsScreen tabParam="preferences" />);
    expect(await screen.findByLabelText("Theme")).toHaveValue("dark");
    expect(screen.getByLabelText("Start with the navigation rail collapsed")).toBeChecked();
  });

  it("shows a refused write as an error without undoing the local effect", async () => {
    serveMe(me());
    api.putPreferences.mockRejectedValue(new Error("console API error 500"));
    render(<SettingsScreen tabParam="preferences" />);
    fireEvent.change(await screen.findByLabelText("Theme"), { target: { value: "dark" } });
    expect(await screen.findByTestId("preferences-outcome")).toHaveTextContent("console API error 500");
    expect(setTheme).toHaveBeenCalledWith("dark");
    expect(screen.getByLabelText("Theme")).toHaveValue("dark");
  });
});

describe("the page", () => {
  it("reads the section from ?tab=", async () => {
    search = "tab=users";
    serveMe(me());
    render(<ConsoleSettingsPage />);
    expect(await screen.findByTestId("current-viewer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
  });

  it("names the failure when the viewer cannot be loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(fakeResponse(503, { error: "AUTH_PROVIDER is unset" })));
    render(<SettingsScreen tabParam="access" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("AUTH_PROVIDER is unset");
  });
});

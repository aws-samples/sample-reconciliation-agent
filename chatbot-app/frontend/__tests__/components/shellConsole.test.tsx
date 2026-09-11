/**
 * The shell's console-layer integration.
 *
 * Pinned: every viewer gets a Settings entry, active on `/console/*`, and a `/console` page renders
 * under the rail with no per-app access panel (it is not an app); the organization label an admin set
 * appears under the mark, with "Console" as the fallback; a stored theme is applied through
 * next-themes once per viewer load; and the stored rail state wins once over the browser value, while
 * the rail's own button persists a new choice to the server only when there is a server to persist to.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetViewerCache } from "@/lib/shell/viewer";

let pathname = "/recon/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/AuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  signOut: vi.fn(),
}));
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: async () => ({}) }));
vi.mock("@/lib/reauth", () => ({ reauthenticate: vi.fn().mockResolvedValue(true) }));
const setTheme = vi.fn();
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme }) }));
const putPreferences = vi.fn();
vi.mock("@/lib/consoleApi", () => ({ putPreferences: (...a: unknown[]) => putPreferences(...a) }));

import { AppShell } from "@/components/shell/AppShell";

/** A `/api/me` body with the console layer's fields. */
function me(over: Record<string, unknown> = {}) {
  return {
    subject: "ana.ferreira",
    groups: [],
    mode: "okta",
    apps: { recon: { access: true, admin: false }, pipeline: { access: true, admin: false } },
    console: { admin: false, configured: true, organizationLabel: "" },
    preferences: {},
    ...over,
  };
}

function serveMe(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "", json: async () => body }));
}

const storage = window.localStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

function stubViewport(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: wide,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const rail = () => screen.getByRole("complementary", { name: "Console navigation" });

beforeEach(() => {
  resetViewerCache();
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  setTheme.mockReset();
  putPreferences.mockReset().mockResolvedValue({});
  stubViewport(true);
  pathname = "/recon/dashboard";
});

describe("Settings entry", () => {
  it("is offered to every viewer, before the viewer has even loaded", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(<AppShell><p>page</p></AppShell>);
    const settings = screen.getByRole("link", { name: "Settings" });
    expect(settings).toHaveAttribute("href", "/console/settings");
    expect(settings).not.toHaveAttribute("aria-current");
    expect(rail()).toContainElement(settings);
  });

  it("is marked current on /console/* and no application is", async () => {
    pathname = "/console/settings";
    serveMe(me());
    render(<AppShell><p>settings page</p></AppShell>);
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    expect((await screen.findByRole("link", { name: "Trade Reconciliation" })).getAttribute("aria-current")).toBeNull();
  });

  it("keeps its name when the rail is collapsed", async () => {
    storage.getItem.mockReturnValue("true");
    serveMe(me());
    render(<AppShell><p>page</p></AppShell>);
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("aria-label", "Settings");
  });
});

describe("console pages under the shell", () => {
  it("renders /console/* immediately, with the rail and without an access panel, even for a viewer with no apps", async () => {
    pathname = "/console/settings";
    serveMe(me({ apps: { recon: { access: false, admin: false }, pipeline: { access: false, admin: false } } }));
    render(<AppShell><p>settings page</p></AppShell>);
    // Not held behind the skeleton: no app owns this path, so there is no access to wait for.
    expect(screen.getByText("settings page")).toBeInTheDocument();
    await screen.findByTestId("rail-subject");
    expect(screen.getByText("settings page")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /No access/ })).toBeNull();
    expect(rail()).toBeInTheDocument();
  });
});

describe("organization label", () => {
  it("shows the stored label under the mark", async () => {
    serveMe(me({ console: { admin: false, configured: true, organizationLabel: "Meridian Capital Ops" } }));
    render(<AppShell><p>page</p></AppShell>);
    await screen.findByTestId("rail-subject");
    expect(screen.getByTestId("rail-organization-label")).toHaveTextContent("Meridian Capital Ops");
  });

  it("falls back to the generic word while loading and when none is set", async () => {
    serveMe(me());
    render(<AppShell><p>page</p></AppShell>);
    expect(screen.getByTestId("rail-organization-label")).toHaveTextContent("Console");
    await screen.findByTestId("rail-subject");
    expect(screen.getByTestId("rail-organization-label")).toHaveTextContent("Console");
  });
});

describe("theme preference", () => {
  it("applies a stored theme through next-themes once the viewer loads", async () => {
    serveMe(me({ preferences: { theme: "dark" } }));
    render(<AppShell><p>page</p></AppShell>);
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"));
    expect(setTheme).toHaveBeenCalledTimes(1);
  });

  it("leaves the browser's theme alone when none is stored", async () => {
    serveMe(me());
    render(<AppShell><p>page</p></AppShell>);
    await screen.findByTestId("rail-subject");
    expect(setTheme).not.toHaveBeenCalled();
  });
});

describe("rail preference", () => {
  it("paints the browser value first, then lets the stored value win once", async () => {
    storage.getItem.mockReturnValue("false");
    serveMe(me({ preferences: { railCollapsed: true } }));
    render(<AppShell><p>page</p></AppShell>);
    // Before /api/me answers: the browser said expanded.
    expect(rail()).toHaveAttribute("data-collapsed", "false");
    await screen.findByTestId("rail-subject");
    // After: the stored preference.
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    // Nothing was written back: applying a stored value is not a choice the user made here.
    expect(putPreferences).not.toHaveBeenCalled();
  });

  it("persists the rail button's choice to the browser and, when configured, to the server", async () => {
    serveMe(me({ preferences: { theme: "light", railCollapsed: false } }));
    render(<AppShell><p>page</p></AppShell>);
    await screen.findByTestId("rail-subject");
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    // The whole row, with the other preference intact: the route replaces the row it is sent.
    expect(putPreferences).toHaveBeenCalledWith({ theme: "light", railCollapsed: true });
    // And the choice sticks: the store now holds the new value, so the stored effect agrees with the click.
    await act(async () => {});
    expect(rail()).toHaveAttribute("data-collapsed", "true");
  });

  it("keeps the choice in the browser only when the console has no stored layer", async () => {
    serveMe(me({ console: { admin: false, configured: false, organizationLabel: "" } }));
    render(<AppShell><p>page</p></AppShell>);
    await screen.findByTestId("rail-subject");
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    expect(putPreferences).not.toHaveBeenCalled();
  });

  it("logs, rather than throws, when the server refuses the write", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    putPreferences.mockRejectedValue(new Error("console API error 502"));
    serveMe(me());
    render(<AppShell><p>page</p></AppShell>);
    await screen.findByTestId("rail-subject");
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    consoleError.mockRestore();
  });
});

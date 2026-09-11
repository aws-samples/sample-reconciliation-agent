/**
 * The console shell: rail plus content column.
 *
 * What is pinned: the rail lists only the apps the viewer may open and marks the current one; collapse
 * is a persisted preference, with the viewport deciding for viewers who never expressed one, and nothing
 * slides on load; a page the viewer may not open is REPLACED by the no-access panel (the APIs already
 * 403 — a page of error placeholders is the failure mode this avoids); a broken `/api/me` still renders
 * the page, with a banner that names the failure and a Retry that recovers the frame without a reload;
 * anonymous mode has no sign-out to offer; the shell's own views carry the landmarks and names assistive
 * tech needs; and the auth handshake pages get no shell at all, not even the request.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "@/lib/auth/apps";
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
const signOut = vi.fn();
vi.mock("@/components/AuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  signOut: () => signOut(),
}));
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: async () => ({}) }));
vi.mock("@/lib/reauth", () => ({ reauthenticate: vi.fn().mockResolvedValue(true) }));

import { AppShell } from "@/components/shell/AppShell";

function viewer(over: Partial<Viewer> = {}): Viewer {
  return {
    subject: "ana.ferreira",
    groups: [],
    mode: "okta",
    apps: {
      recon: { access: true, admin: false },
      pipeline: { access: true, admin: false },
    },
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 300, status, statusText: "", json: async () => body };
}

/** Stub `/api/me`; returns the mock so a test can assert on call counts. */
function serveMe(body: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(body, status));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const storage = window.localStorage as unknown as {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
};

/**
 * A `matchMedia` whose answer and change events the test controls. The global setup stubs it to
 * "never matches", which would collapse the rail in every test; the shell tests default to a wide
 * viewport so the pre-existing expectations (expanded rail) keep meaning what they say.
 */
function stubViewport(wide: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: wide,
    media: query,
    onchange: null,
    addEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: { matches: boolean }) => void) => listeners.delete(l),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  return {
    resize(nowWide: boolean) {
      act(() => listeners.forEach((l) => l({ matches: nowWide })));
    },
  };
}

function page(text = "page") {
  return (
    <AppShell>
      <p>{text}</p>
    </AppShell>
  );
}

const rail = () => screen.getByRole("complementary", { name: "Console navigation" });

beforeEach(() => {
  resetViewerCache();
  signOut.mockReset().mockResolvedValue(undefined);
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  stubViewport(true);
  pathname = "/recon/dashboard";
});

describe("AppShell rail", () => {
  it("shows a skeleton rail while the viewer loads, never an empty one", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(page());
    expect(rail()).toBeInTheDocument();
    expect(screen.getByTestId("app-rail-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Trade Reconciliation/ })).toBeNull();
  });

  it("lists only the apps the viewer may open", async () => {
    serveMe(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(page());
    const recon = await screen.findByRole("link", { name: "Trade Reconciliation" });
    expect(recon).toHaveAttribute("href", "/recon/dashboard");
    expect(screen.queryByRole("link", { name: "Deal Pipeline" })).toBeNull();
    expect(screen.getByText("page")).toBeInTheDocument();
  });

  it("marks the app that owns the current path", async () => {
    pathname = "/pipeline/deals/dl_1";
    serveMe(viewer());
    render(page());
    const pipeline = await screen.findByRole("link", { name: "Deal Pipeline" });
    expect(pipeline).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Trade Reconciliation" })).not.toHaveAttribute("aria-current");
  });

  it("shows the subject and a named admin chip only where the viewer administers the current app", async () => {
    pathname = "/recon/config";
    serveMe(viewer({ apps: { recon: { access: true, admin: true }, pipeline: { access: true, admin: false } } }));
    render(page());
    expect(await screen.findByTestId("rail-subject")).toHaveTextContent("ana.ferreira");
    // The chip's meaning is its accessible name, in both rail widths — `title` alone is a tooltip.
    expect(screen.getByRole("img", { name: "Administrator of this application" })).toBe(
      screen.getByTestId("admin-chip"),
    );
  });

  it("hides the admin chip on an app the viewer only uses", async () => {
    pathname = "/pipeline/inbox";
    serveMe(viewer({ apps: { recon: { access: true, admin: true }, pipeline: { access: true, admin: false } } }));
    render(page());
    await screen.findByTestId("rail-subject");
    expect(screen.queryByTestId("admin-chip")).toBeNull();
  });

  it("collapses on toggle, persists the choice, and names icon-only entries", async () => {
    serveMe(viewer());
    render(page());
    await screen.findByRole("link", { name: "Trade Reconciliation" });

    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", rail().id);
    fireEvent.click(toggle);

    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    const expand = screen.getByRole("button", { name: "Expand navigation" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    // Icon-only entries keep their name through aria-label (not only the tooltip) and their target.
    const recon = screen.getByRole("link", { name: "Trade Reconciliation" });
    expect(recon).toHaveAttribute("aria-label", "Trade Reconciliation");
    expect(recon).toHaveAttribute("title", "Trade Reconciliation");
    expect(recon).toHaveAttribute("href", "/recon/dashboard");

    fireEvent.click(expand);
    expect(storage.setItem).toHaveBeenLastCalledWith("shell:rail:collapsed", "false");
  });

  it("starts collapsed when the preference was saved, without animating into it", async () => {
    storage.getItem.mockReturnValue("true");
    serveMe(viewer());
    render(page());
    // Synchronously after mount: the stored width is applied before the first paint the user sees,
    // and the width transition is off until something changes AFTER that — a class added in the same
    // commit as the width change would animate the collapse on every hard load.
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(rail().className).not.toContain("transition-[width]");

    await screen.findByRole("link", { name: "Trade Reconciliation" });
    fireEvent.click(screen.getByRole("button", { name: "Expand navigation" }));
    expect(rail()).toHaveAttribute("data-collapsed", "false");
    expect(rail().className).toContain("transition-[width]");
  });

  it("starts collapsed below the lg breakpoint when the viewer never chose", async () => {
    const viewport = stubViewport(false);
    serveMe(viewer());
    render(page());
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    expect(storage.setItem).not.toHaveBeenCalled();

    // Widening the window past the breakpoint re-expands it; that change may animate.
    viewport.resize(true);
    expect(rail()).toHaveAttribute("data-collapsed", "false");
    expect(rail().className).toContain("transition-[width]");
    viewport.resize(false);
    expect(rail()).toHaveAttribute("data-collapsed", "true");
    await screen.findByRole("link", { name: "Trade Reconciliation" });
  });

  it("honours an explicit preference at every width", async () => {
    const viewport = stubViewport(false);
    storage.getItem.mockReturnValue("false");
    serveMe(viewer());
    render(page());
    expect(rail()).toHaveAttribute("data-collapsed", "false");

    viewport.resize(true);
    viewport.resize(false);
    expect(rail()).toHaveAttribute("data-collapsed", "false");

    // And a choice made now stops the viewport from deciding afterwards.
    await screen.findByRole("link", { name: "Trade Reconciliation" });
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    viewport.resize(true);
    expect(rail()).toHaveAttribute("data-collapsed", "true");
  });

  it("signs out through the auth wrapper", async () => {
    serveMe(viewer());
    render(page());
    await screen.findByRole("link", { name: "Trade Reconciliation" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("says so when the provider refuses to sign out instead of doing nothing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    signOut.mockRejectedValue(new Error("uninitialized_public_client_application"));
    serveMe(viewer());
    render(page());
    await screen.findByRole("link", { name: "Trade Reconciliation" });

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign out failed");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("offers no sign-out in anonymous mode and labels the identity as local", async () => {
    serveMe(viewer({ subject: "anonymous", mode: "anonymous" }));
    render(page());
    await screen.findByRole("link", { name: "Trade Reconciliation" });
    // With no identity provider there is no session to end; the SDKs would only reject.
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
    expect(screen.getByTestId("rail-subject")).toHaveTextContent("anonymous");
    expect(
      screen.getByRole("img", { name: "Local development mode: no identity provider is configured" }),
    ).toBe(screen.getByTestId("local-chip"));
  });
});

describe("AppShell content gating", () => {
  it("replaces the page with a no-access panel when the viewer may not open this app", async () => {
    pathname = "/pipeline/inbox";
    serveMe(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(page("secret page"));
    expect(await screen.findByRole("heading", { name: "No access to Deal Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the console" })).toHaveAttribute("href", "/");
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it("holds an app page behind a skeleton until access is known", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(page("app page"));
    expect(screen.getByTestId("shell-content-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("app page")).toBeNull();
  });

  it("renders a non-app page immediately while the viewer loads", () => {
    pathname = "/";
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(page("landing"));
    expect(screen.getByText("landing")).toBeInTheDocument();
  });

  it("renders the page plus a banner naming the failure when /api/me breaks", async () => {
    serveMe({ error: "recon API authorization is not configured: AUTH_PROVIDER is unset" }, 503);
    render(page());
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("503");
    expect(banner).toHaveTextContent("AUTH_PROVIDER is unset");
    expect(screen.getByText("page")).toBeInTheDocument();
    // No apps are known, so the rail says so instead of showing an empty list.
    expect(screen.getByText("Applications unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // The banner is the one shell surface that sits on `body` — white in the light scheme — so its
    // background must be opaque for the message to be readable there.
    expect(banner.parentElement?.className).toContain("bg-[var(--shell-danger-panel)]");
    expect(banner.className).not.toContain("truncate");
  });

  it("recovers the rail and the gating from a Retry without remounting the frame", async () => {
    pathname = "/pipeline/inbox";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "upstream connect error" }, 502))
      .mockResolvedValueOnce(
        jsonResponse(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(page("secret page"));

    // One transient 502: the page renders under the banner because access is unknown.
    await screen.findByRole("alert");
    expect(screen.getByText("secret page")).toBeInTheDocument();
    expect(screen.getByText("Applications unavailable")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    // The frame was never remounted, yet the answer reaches it: the rail fills in and the gating applies.
    expect(await screen.findByRole("heading", { name: "No access to Deal Pipeline" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("secret page")).toBeNull();
    expect(screen.getByRole("link", { name: "Trade Reconciliation" })).toBeInTheDocument();
    expect(screen.queryByText("Applications unavailable")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["/login", "/login/callback", "/oauth-complete"])("renders no shell on %s", (path) => {
    pathname = path;
    const fetchMock = serveMe(viewer());
    render(page("handshake"));
    expect(screen.getByText("handshake")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AppShell accessibility", () => {
  it("puts a skip link first that lands on the content column", async () => {
    serveMe(viewer());
    render(page());
    const skip = screen.getByRole("link", { name: "Skip to content" });
    // First focusable thing on the page, ahead of the rail's four or five stops.
    expect(skip.compareDocumentPosition(rail()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const target = document.getElementById(skip.getAttribute("href")!.slice(1));
    expect(target).not.toBeNull();
    expect(target).toHaveAttribute("tabindex", "-1");
    expect(target).toContainElement(await screen.findByText("page"));
  });

  it("gives the shell's own views a main landmark, with the live region on the explanation only", async () => {
    pathname = "/pipeline/inbox";
    serveMe(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(page("secret page"));
    // Wait for the panel itself: the skeleton that precedes it is a `<main>` too.
    const heading = await screen.findByRole("heading", { name: "No access to Deal Pipeline" });
    expect(screen.getByRole("main")).toContainElement(heading);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Your account is not in the group");
    expect(status).not.toContainElement(screen.getByRole("link", { name: "Back to the console" }));
  });

  it("keeps a main landmark while an app page is held behind the skeleton", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(page("app page"));
    expect(screen.getByTestId("shell-content-skeleton").tagName).toBe("MAIN");
  });

  it("does not add a second main around an app page, which brings its own", async () => {
    serveMe(viewer());
    render(
      <AppShell>
        <main>app main</main>
      </AppShell>,
    );
    await screen.findByRole("link", { name: "Trade Reconciliation" });
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});

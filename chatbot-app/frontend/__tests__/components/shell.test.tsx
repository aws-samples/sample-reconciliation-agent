/**
 * The console shell: rail plus content column.
 *
 * What is pinned: the rail lists only the apps the viewer may open and marks the current one; collapse
 * is a persisted preference; a page the viewer may not open is REPLACED by the no-access panel (the
 * APIs already 403 — a page of error placeholders is the failure mode this avoids); a broken `/api/me`
 * still renders the page, with a banner that names the failure; and the auth handshake pages get no
 * shell at all, not even the request.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/pipeline-auth", () => ({ authHeaders: async () => ({}) }));

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

beforeEach(() => {
  resetViewerCache();
  signOut.mockReset();
  storage.getItem.mockReset().mockReturnValue(null);
  storage.setItem.mockReset();
  pathname = "/recon/dashboard";
});

describe("AppShell rail", () => {
  it("shows a skeleton rail while the viewer loads, never an empty one", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(screen.getByRole("complementary", { name: "Console navigation" })).toBeInTheDocument();
    expect(screen.getByTestId("app-rail-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Trade Reconciliation/ })).toBeNull();
  });

  it("lists only the apps the viewer may open", async () => {
    serveMe(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    const recon = await screen.findByRole("link", { name: "Trade Reconciliation" });
    expect(recon).toHaveAttribute("href", "/recon/dashboard");
    expect(screen.queryByRole("link", { name: "Deal Pipeline" })).toBeNull();
    expect(screen.getByText("page")).toBeInTheDocument();
  });

  it("marks the app that owns the current path", async () => {
    pathname = "/pipeline/deals/dl_1";
    serveMe(viewer());
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    const pipeline = await screen.findByRole("link", { name: "Deal Pipeline" });
    expect(pipeline).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Trade Reconciliation" })).not.toHaveAttribute("aria-current");
  });

  it("shows the subject and an admin chip only where the viewer administers the current app", async () => {
    pathname = "/recon/config";
    serveMe(viewer({ apps: { recon: { access: true, admin: true }, pipeline: { access: true, admin: false } } }));
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    expect(await screen.findByTestId("rail-subject")).toHaveTextContent("ana.ferreira");
    expect(screen.getByTestId("admin-chip")).toBeInTheDocument();
  });

  it("hides the admin chip on an app the viewer only uses", async () => {
    pathname = "/pipeline/inbox";
    serveMe(viewer({ apps: { recon: { access: true, admin: true }, pipeline: { access: true, admin: false } } }));
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    await screen.findByTestId("rail-subject");
    expect(screen.queryByTestId("admin-chip")).toBeNull();
  });

  it("collapses on toggle, persists the choice, and keeps labels as tooltips", async () => {
    serveMe(viewer());
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    await screen.findByRole("link", { name: "Trade Reconciliation" });

    const toggle = screen.getByRole("button", { name: "Collapse navigation" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);

    expect(storage.setItem).toHaveBeenCalledWith("shell:rail:collapsed", "true");
    const aside = screen.getByRole("complementary", { name: "Console navigation" });
    expect(aside).toHaveAttribute("data-collapsed", "true");
    const expand = screen.getByRole("button", { name: "Expand navigation" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    // Icon-only entries still announce and tooltip their label.
    expect(screen.getByTitle("Trade Reconciliation")).toHaveAttribute("href", "/recon/dashboard");

    fireEvent.click(expand);
    expect(storage.setItem).toHaveBeenLastCalledWith("shell:rail:collapsed", "false");
  });

  it("starts collapsed when the preference was saved", async () => {
    storage.getItem.mockReturnValue("true");
    serveMe(viewer());
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    await waitFor(() =>
      expect(screen.getByRole("complementary", { name: "Console navigation" })).toHaveAttribute(
        "data-collapsed",
        "true",
      ),
    );
  });

  it("signs out through the auth wrapper", async () => {
    serveMe(viewer());
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    await screen.findByRole("link", { name: "Trade Reconciliation" });
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});

describe("AppShell content gating", () => {
  it("replaces the page with a no-access panel when the viewer may not open this app", async () => {
    pathname = "/pipeline/inbox";
    serveMe(viewer({ apps: { recon: { access: true, admin: false }, pipeline: { access: false, admin: false } } }));
    render(
      <AppShell>
        <p>secret page</p>
      </AppShell>,
    );
    expect(await screen.findByRole("heading", { name: "No access to Deal Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to the console" })).toHaveAttribute("href", "/");
    expect(screen.queryByText("secret page")).toBeNull();
  });

  it("holds an app page behind a skeleton until access is known", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <AppShell>
        <p>app page</p>
      </AppShell>,
    );
    expect(screen.getByTestId("shell-content-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("app page")).toBeNull();
  });

  it("renders a non-app page immediately while the viewer loads", () => {
    pathname = "/";
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(
      <AppShell>
        <p>landing</p>
      </AppShell>,
    );
    expect(screen.getByText("landing")).toBeInTheDocument();
  });

  it("renders the page plus a banner naming the failure when /api/me breaks", async () => {
    serveMe({ error: "recon API authorization is not configured: AUTH_PROVIDER is unset" }, 503);
    render(
      <AppShell>
        <p>page</p>
      </AppShell>,
    );
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("503");
    expect(banner).toHaveTextContent("AUTH_PROVIDER is unset");
    expect(screen.getByText("page")).toBeInTheDocument();
    // No apps are known, so the rail says so instead of showing an empty list.
    expect(screen.getByText("Applications unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it.each(["/login", "/login/callback", "/oauth-complete"])("renders no shell on %s", (path) => {
    pathname = path;
    const fetchMock = serveMe(viewer());
    render(
      <AppShell>
        <p>handshake</p>
      </AppShell>,
    );
    expect(screen.getByText("handshake")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

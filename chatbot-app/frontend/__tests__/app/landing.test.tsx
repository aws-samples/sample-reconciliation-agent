/**
 * The console landing.
 *
 * It replaces a hard redirect to the recon dashboard, so the property that matters most is that a
 * viewer with exactly one application still lands there without seeing a chooser. Two or more get the
 * chooser; none get told what to ask for; a broken `/api/me` gets the reason and a way out.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "@/lib/auth/apps";
import { resetViewerCache } from "@/lib/shell/viewer";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: (...a: unknown[]) => replace(...a) }),
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

import Home from "@/app/page";

function viewer(apps: Viewer["apps"]): Viewer {
  return { subject: "ana.ferreira", groups: [], mode: "okta", apps };
}

function serveMe(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status < 300, status, statusText: "", json: async () => body }),
  );
}

beforeEach(() => {
  resetViewerCache();
  replace.mockReset();
  signOut.mockReset();
});

describe("landing page", () => {
  it("shows a centered skeleton while the viewer loads", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(<Home />);
    expect(screen.getByTestId("landing-skeleton")).toBeInTheDocument();
  });

  it("redirects straight into the only accessible app", async () => {
    serveMe(viewer({ recon: { access: true, admin: false }, pipeline: { access: false, admin: false } }));
    render(<Home />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/recon/dashboard"));
    // No chooser flashes before the navigation lands.
    expect(screen.queryByRole("heading", { name: "Agentic Operations Console" })).toBeNull();
    expect(screen.getByTestId("landing-skeleton")).toBeInTheDocument();
  });

  it("redirects into the pipeline when that is the only one", async () => {
    serveMe(viewer({ recon: { access: false, admin: false }, pipeline: { access: true, admin: true } }));
    render(<Home />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/pipeline/inbox"));
  });

  it("offers a card per accessible app when there are several", async () => {
    serveMe(viewer({ recon: { access: true, admin: false }, pipeline: { access: true, admin: false } }));
    render(<Home />);
    expect(await screen.findByRole("heading", { name: "Agentic Operations Console" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trade Reconciliation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deal Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Trade Reconciliation" })).toHaveAttribute("href", "/recon/dashboard");
    expect(screen.getByRole("link", { name: "Open Deal Pipeline" })).toHaveAttribute("href", "/pipeline/inbox");
    expect(replace).not.toHaveBeenCalled();
  });

  it("tells a viewer with no apps what to ask for, with a way to sign out", async () => {
    serveMe(viewer({ recon: { access: false, admin: false }, pipeline: { access: false, admin: false } }));
    render(<Home />);
    expect(
      await screen.findByText(
        "You do not have access to any application. Ask an administrator to add you to an access group.",
      ),
    ).toBeInTheDocument();
    screen.getByRole("button", { name: "Sign out" }).click();
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("names the failure when /api/me breaks instead of showing an empty chooser", async () => {
    serveMe({ error: "identity provider unreachable" }, 503);
    render(<Home />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("503");
    expect(alert).toHaveTextContent("identity provider unreachable");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});

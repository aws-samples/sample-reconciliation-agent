/**
 * The console landing.
 *
 * It replaces a hard redirect to the recon dashboard, so the property that matters most is that a
 * viewer with exactly one application still lands there without seeing a chooser. Two or more get the
 * chooser; none get told what to ask for; a broken `/api/me` gets the reason and two ways out — signing
 * in again (an expired session the automatic redirect declined to retry) or signing out; anonymous mode
 * offers neither, having no session to end. Every view is the page's `<main>`.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/lib/auth/client-token", () => ({ authHeaders: async () => ({}) }));
const reauthenticate = vi.fn();
vi.mock("@/lib/reauth", () => ({ reauthenticate: (...a: unknown[]) => reauthenticate(...a) }));

import Home from "@/app/page";

function viewer(apps: Viewer["apps"], over: Partial<Viewer> = {}): Viewer {
  return { subject: "ana.ferreira", groups: [], mode: "okta", apps, ...over };
}

function serveMe(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: status < 300, status, statusText: "", json: async () => body }),
  );
}

const NONE: Viewer["apps"] = { recon: { access: false, admin: false }, pipeline: { access: false, admin: false } };
const BOTH: Viewer["apps"] = { recon: { access: true, admin: false }, pipeline: { access: true, admin: false } };

beforeEach(() => {
  resetViewerCache();
  replace.mockReset();
  signOut.mockReset().mockResolvedValue(undefined);
  reauthenticate.mockReset().mockResolvedValue(true);
});

describe("landing page", () => {
  it("shows a centered skeleton while the viewer loads", () => {
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(<Home />);
    expect(screen.getByTestId("landing-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("landing-skeleton").tagName).toBe("MAIN");
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
    serveMe(viewer(BOTH));
    render(<Home />);
    expect(await screen.findByRole("heading", { name: "Agentic Operations Console" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Trade Reconciliation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Deal Pipeline" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Trade Reconciliation" })).toHaveAttribute("href", "/recon/dashboard");
    expect(screen.getByRole("link", { name: "Open Deal Pipeline" })).toHaveAttribute("href", "/pipeline/inbox");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { name: "Agentic Operations Console" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("tells a viewer with no apps what to ask for, with a way to sign out", async () => {
    serveMe(viewer(NONE));
    render(<Home />);
    expect(
      await screen.findByText(
        "You do not have access to any application. Ask an administrator to add you to an access group.",
      ),
    ).toBeInTheDocument();
    // The live region is the explanation; the button is outside it.
    expect(screen.getByRole("status")).not.toContainElement(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("main")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers no sign-out to an anonymous viewer with no apps", async () => {
    serveMe(viewer(NONE, { subject: "anonymous", mode: "anonymous" }));
    render(<Home />);
    await screen.findByText(/You do not have access to any application/);
    // No identity provider, no session to end: the SDKs would only reject, and the control would be inert.
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  it("surfaces a sign-out the provider refused", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    signOut.mockRejectedValue(new Error("No issuer passed to constructor"));
    serveMe(viewer(NONE));
    render(<Home />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sign out failed");
    consoleError.mockRestore();
  });

  it("names the failure when /api/me breaks instead of showing an empty chooser", async () => {
    serveMe({ error: "identity provider unreachable" }, 503);
    render(<Home />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("503");
    expect(alert).toHaveTextContent("identity provider unreachable");
    expect(screen.getByRole("main")).toContainElement(alert);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("lets the viewer sign in again from the failure card, bypassing the automatic loop guard", async () => {
    serveMe({ error: "missing or malformed Authorization header" }, 401);
    render(<Home />);
    await screen.findByRole("alert");
    // The automatic attempt (trigger "unauthorized") has already been made by the fetch itself; the
    // button is the user-driven retry for when that one was refused.
    expect(reauthenticate).toHaveBeenCalledWith("unauthorized");

    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(reauthenticate).toHaveBeenLastCalledWith("user");
  });

  it("does not offer sign-in from the no-apps card, where the session is fine", async () => {
    serveMe(viewer(NONE));
    render(<Home />);
    await screen.findByText(/You do not have access to any application/);
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });
});

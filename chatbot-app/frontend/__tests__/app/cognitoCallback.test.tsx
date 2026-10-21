/**
 * The Cognito redirect landing page.
 *
 * Without this route Next.js 404s the hosted UI's redirect and the user is stranded after signing in,
 * which is the only reason it exists. The exchange itself belongs to CognitoAuthWrapper (it renders in
 * front of every page, including this one), so all that is under test here is the forward: the user
 * ends up where they asked to go, and the shell stays out of the way while they are here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const { fns } = vi.hoisted(() => ({
  fns: { replace: vi.fn(), consumeReturnTo: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: fns.replace }),
}));
vi.mock("@/lib/auth/cognito-pkce", () => ({
  consumeReturnTo: fns.consumeReturnTo,
}));

import CognitoCallback from "@/app/callback/page";
import { isShellHidden } from "@/lib/shell/viewer";

describe("/callback", () => {
  beforeEach(() => {
    fns.replace.mockReset();
    fns.consumeReturnTo.mockReset().mockReturnValue("/recon/dashboard");
  });

  it("forwards to the page the user asked for before signing in", async () => {
    render(<CognitoCallback />);
    await waitFor(() => expect(fns.replace).toHaveBeenCalledWith("/recon/dashboard"));
    // And says something in the meantime rather than flashing an empty page.
    expect(screen.getByText(/completing sign-in/i)).toBeTruthy();
  });

  it("falls back to the console landing when nothing was recorded", async () => {
    // `/` opens the only accessible app, or shows the chooser.
    fns.consumeReturnTo.mockReturnValue("/");
    render(<CognitoCallback />);
    await waitFor(() => expect(fns.replace).toHaveBeenCalledWith("/"));
  });

  it("is a shell-hidden path, like every other auth handshake route", () => {
    // The rail asks `/api/me` who is signed in, which is not answerable while the handshake is still
    // finishing — and a rail that flashed up here would be replaced a tick later anyway.
    expect(isShellHidden("/callback")).toBe(true);
  });
});

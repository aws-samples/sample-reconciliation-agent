/**
 * The provider selector: which gate the app mounts, and which provider `signOut()` ends the session
 * with.
 *
 * The headline behaviour is the DEFAULT. `NEXT_PUBLIC_AUTH_PROVIDER` unset used to mean Entra, which
 * made this sample unrunnable in a customer account without an external IdP tenant; it now means
 * Cognito, whose user pool the same Terraform creates. Everything that was already SET keeps working
 * exactly as it did — that is the other half of what this file pins down.
 *
 * The three wrappers are mocked: which one is chosen is this module's whole job, and each one's own
 * behaviour has its own test file.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { fns } = vi.hoisted(() => ({
  fns: {
    cognitoSignOut: vi.fn(),
    oktaSignOut: vi.fn(),
    entraSignOut: vi.fn(),
  },
}));

vi.mock("@/components/CognitoAuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="cognito-gate">{children}</div>
  ),
  cognitoSignOut: fns.cognitoSignOut,
}));
vi.mock("@/components/OktaAuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="okta-gate">{children}</div>
  ),
  oktaSignOut: fns.oktaSignOut,
  oktaUserName: vi.fn(),
}));
vi.mock("@/components/EntraAuthWrapper", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="entra-gate">{children}</div>
  ),
  entraSignOut: fns.entraSignOut,
}));

/** Load a fresh AuthWrapper (and the provider module underneath it) bound to `value`. */
async function loadAuthWrapper(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  else process.env.NEXT_PUBLIC_AUTH_PROVIDER = value;
  vi.resetModules();
  return import("@/components/AuthWrapper");
}

describe("AuthWrapper", () => {
  const saved = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  beforeEach(() => {
    fns.cognitoSignOut.mockReset().mockResolvedValue(undefined);
    fns.oktaSignOut.mockReset().mockResolvedValue(undefined);
    fns.entraSignOut.mockReset().mockResolvedValue(undefined);
  });

  afterAll(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    else process.env.NEXT_PUBLIC_AUTH_PROVIDER = saved;
  });

  it.each([
    // The change: no variable set, and the app signs in with the pool this repo can create.
    [undefined, "cognito-gate"],
    ["", "cognito-gate"],
    ["cognito", "cognito-gate"],
    ["okta", "okta-gate"],
    ["entra", "entra-gate"],
    // An unrecognised value still lands where it always did.
    ["saml", "entra-gate"],
  ])("mounts the %s gate", async (provider, testId) => {
    const { default: AuthWrapper } = await loadAuthWrapper(provider);
    render(
      <AuthWrapper>
        <p>protected</p>
      </AuthWrapper>,
    );
    expect(screen.getByTestId(testId)).toBeTruthy();
    // The gate wraps the app rather than replacing it.
    expect(screen.getByText("protected")).toBeTruthy();
  });

  it.each([
    [undefined, "cognitoSignOut"],
    ["cognito", "cognitoSignOut"],
    ["okta", "oktaSignOut"],
    ["entra", "entraSignOut"],
  ] as const)("signs out through the %s provider", async (provider, expected) => {
    // Signing in with one provider and out through another would leave the session alive at the IdP
    // while the app believed it was over.
    const { signOut } = await loadAuthWrapper(provider);
    await signOut();
    for (const [name, fn] of Object.entries(fns)) {
      if (name === expected) expect(fn).toHaveBeenCalled();
      else expect(fn).not.toHaveBeenCalled();
    }
  });

  it("propagates a sign-out failure so the shell can report it", async () => {
    // `lib/shell/signOut.ts` shows the user a message; swallowing this is how a button that does
    // nothing gets shipped.
    const { signOut } = await loadAuthWrapper(undefined);
    fns.cognitoSignOut.mockRejectedValue(new Error("not configured"));
    await expect(signOut()).rejects.toThrow(/not configured/);
  });
});

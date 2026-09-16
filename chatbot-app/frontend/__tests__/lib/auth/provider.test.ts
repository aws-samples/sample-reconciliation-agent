/**
 * Which provider the browser signs in with — the one reader of `NEXT_PUBLIC_AUTH_PROVIDER`.
 *
 * Two properties, and the second is the one that needs guarding. Cognito is the default so the sample
 * is runnable without an external IdP tenant; and every value that was already SET keeps the meaning
 * it had, including a misspelled one. Changing the meaning of not setting the variable is the decision
 * that was made; changing the meaning of a value someone has already deployed is not, and the table
 * below is what stops a later tidy-up (a `.toLowerCase()`, a `.trim()`) from quietly doing it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

/** Load a fresh copy bound to `value`; `undefined` unsets the variable. */
async function load(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
  else process.env.NEXT_PUBLIC_AUTH_PROVIDER = value;
  vi.resetModules();
  return import("@/lib/auth/provider");
}

describe("authProviderBranch", () => {
  const saved = process.env.NEXT_PUBLIC_AUTH_PROVIDER;

  afterAll(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_AUTH_PROVIDER;
    else process.env.NEXT_PUBLIC_AUTH_PROVIDER = saved;
  });

  it.each([
    // The change: unset now means Cognito, so a customer who deploys the sample as-is can sign in.
    [undefined, "cognito"],
    // A build argument declared with no value renders as "", which is the same as unset.
    ["", "cognito"],
    ["cognito", "cognito"],
    // Unchanged from before Cognito existed.
    ["okta", "okta"],
    ["entra", "entra"],
    // Unchanged too, and deliberately so: an unrecognised value resolved to Entra yesterday.
    ["Okta", "entra"],
    [" okta ", "entra"],
    ["saml", "entra"],
  ])("%s -> %s", async (value, expected) => {
    const { authProviderBranch } = await load(value);
    expect(authProviderBranch()).toBe(expected);
  });

  it("exposes the raw value for error messages", async () => {
    // `reauth.ts` quotes it when it cannot redirect, so it must be what the deployment actually said.
    expect((await load("saml")).AUTH_PROVIDER).toBe("saml");
    expect((await load(undefined)).AUTH_PROVIDER).toBe("cognito");
  });
});

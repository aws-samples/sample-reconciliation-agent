/**
 * The MSAL browser stand-in the ID-token reader tests share.
 *
 * Replaces the `@/lib/msal-config` + `@azure/msal-browser` mock pair that `lib/auth/client-token.test.ts`
 * carried (and that the recon token tests still carry inline). Build one at module scope and hand its
 * two module objects to `vi.mock`; the `vi.fn()`s on it are what a case scripts.
 *
 * Hoisting: `vi.mock` calls are hoisted above every import, but their factories run lazily — at the
 * moment the mocked module is first imported. A module-body `const msal = fakeMsal()` is therefore
 * safe ONLY when the subject is loaded with `await import()` after that line. A static import of a
 * subject that eagerly imports the mocked module runs the factory before the `const` is initialised
 * and throws a ReferenceError; the token reader happens to import MSAL lazily inside a function, but
 * do not rely on that — use `await import()` for the subject.
 *
 * Not a test file (no `.test.` in the name), so vitest does not collect it.
 */
import { vi } from "vitest";

/** An Entra configuration that says "configured", with no real tenant in it. */
export const MSAL_CONFIG_MODULE = {
  HAS_ENTRA_CONFIG: true,
  msalConfig: { auth: { clientId: "c", authority: "https://login" } },
  tokenRequest: { scopes: ["openid"] },
  ENTRA_OBO_SCOPE: "",
} as const;

export function fakeMsal() {
  const account = { homeAccountId: "acct-1" };
  const acquireTokenSilent = vi.fn();
  const getActiveAccount = vi.fn(() => account as unknown);
  const loginRedirect = vi.fn();
  return {
    account,
    acquireTokenSilent,
    getActiveAccount,
    loginRedirect,
    /** For `vi.mock("@/lib/msal-config", () => msal.configModule)`. */
    configModule: MSAL_CONFIG_MODULE,
    /** For `vi.mock("@azure/msal-browser", () => msal.browserModule)`. */
    browserModule: {
      PublicClientApplication: class {
        getActiveAccount = getActiveAccount;
        getAllAccounts = () => [account];
        acquireTokenSilent = acquireTokenSilent;
        loginRedirect = loginRedirect;
      },
    },
  };
}

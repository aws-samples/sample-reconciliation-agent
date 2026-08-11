/**
 * Okta callback-URL resolution (live-QA P0-1).
 *
 * The defect was that the redirect URI came only from `window.location.origin`, so it silently
 * became whatever host served the app — a generated *.cloudfront.net domain that changes when the
 * distribution is recreated, at which point Okta rejects the login because that URI was never
 * registered. These tests pin the precedence: an explicitly configured URI always wins.
 *
 * `NEXT_PUBLIC_*` values are read at module load, so each case re-imports the module with
 * `vi.resetModules()` after setting the environment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN_URI = "http://localhost:3000/login/callback";
const PINNED_URI = "https://recon.example.com/login/callback";

/** Load a fresh copy of okta-config with `NEXT_PUBLIC_OKTA_REDIRECT_URI` set to `value`. */
async function loadConfig(value?: string) {
  if (value === undefined) {
    delete process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI;
  } else {
    process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI = value;
  }
  vi.resetModules();
  return import("@/lib/okta-config");
}

describe("oktaRedirectUri", () => {
  const saved = process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI;
    else process.env.NEXT_PUBLIC_OKTA_REDIRECT_URI = saved;
  });

  it("derives the URI from the browser origin when nothing is pinned", async () => {
    const { oktaRedirectUri, OKTA_REDIRECT_URI_IS_PINNED } =
      await loadConfig(undefined);
    // jsdom serves the suite from http://localhost:3000.
    expect(oktaRedirectUri()).toBe(ORIGIN_URI);
    expect(OKTA_REDIRECT_URI_IS_PINNED).toBe(false);
  });

  it("prefers the pinned URI over the browser origin", async () => {
    const { oktaRedirectUri, OKTA_REDIRECT_URI_IS_PINNED } =
      await loadConfig(PINNED_URI);
    expect(oktaRedirectUri()).toBe(PINNED_URI);
    expect(OKTA_REDIRECT_URI_IS_PINNED).toBe(true);
  });

  it("is stable across origins — the whole point of pinning", async () => {
    const { oktaRedirectUri } = await loadConfig(PINNED_URI);
    const first = oktaRedirectUri();
    // Stand in for a redeploy handing out a brand-new CloudFront domain.
    vi.spyOn(window, "location", "get").mockReturnValue({
      origin: "https://d111111abcdef8.cloudfront.net",
    } as Location);
    expect(oktaRedirectUri()).toBe(first);
    vi.restoreAllMocks();
  });

  it("treats whitespace-only configuration as unset", async () => {
    const { oktaRedirectUri, OKTA_REDIRECT_URI_IS_PINNED } =
      await loadConfig("   ");
    expect(OKTA_REDIRECT_URI_IS_PINNED).toBe(false);
    expect(oktaRedirectUri()).toBe(ORIGIN_URI);
  });

  it("tolerates a trailing slash", async () => {
    const { oktaRedirectUri } = await loadConfig(`${PINNED_URI}/`);
    expect(oktaRedirectUri()).toBe(PINNED_URI);
  });

  // Fail loudly: a typo here would otherwise surface only as Okta's own opaque login error.
  it("throws when the pinned value is not absolute", async () => {
    const { oktaRedirectUri } = await loadConfig("/login/callback");
    expect(() => oktaRedirectUri()).toThrow(/absolute URL/);
  });

  it("throws when the pinned value does not point at the callback route", async () => {
    const { oktaRedirectUri } = await loadConfig("https://recon.example.com");
    expect(() => oktaRedirectUri()).toThrow(/must end with \/login\/callback/);
  });
});

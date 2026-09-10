/**
 * BFF authorization. The security property under test is deny-by-default:
 * no configuration and no token must never resolve to "allowed".
 *
 * Runs on the node environment, not the suite's default jsdom: this is server-side middleware
 * code, and under jsdom jose's `payload instanceof Uint8Array` check fails because the encoder
 * and the global constructor come from different realms.
 */
// @vitest-environment node

import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import {
  authorizeRequest,
  oktaJwksUri,
  resolveApiAuth,
  type ApiAuthConfig,
} from "@/lib/api-auth";

const ISSUER = "https://integrator-1234567.okta.com/oauth2/default";
const CLIENT_ID = "0oaTESTclientid";

describe("resolveApiAuth", () => {
  it("resolves okta from the runtime (non-NEXT_PUBLIC) env vars", () => {
    const config = resolveApiAuth({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: ISSUER,
      OKTA_CLIENT_ID: CLIENT_ID,
    });
    expect(config).toEqual({
      mode: "okta",
      issuer: ISSUER,
      audience: CLIENT_ID,
      jwksUri: `${ISSUER}/v1/keys`,
    });
  });

  it("trims a trailing slash off the issuer so the JWKS URL is well-formed", () => {
    const config = resolveApiAuth({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: `${ISSUER}/`,
      OKTA_CLIENT_ID: CLIENT_ID,
    });
    expect(config.issuer).toBe(ISSUER);
    expect(config.jwksUri).toBe(`${ISSUER}/v1/keys`);
  });

  it("resolves entra to the v2 issuer and discovery keys", () => {
    const config = resolveApiAuth({
      AUTH_PROVIDER: "entra",
      ENTRA_TENANT_ID: "tenant-1",
      ENTRA_CLIENT_ID: "client-1",
    });
    expect(config.mode).toBe("entra");
    expect(config.issuer).toBe(
      "https://login.microsoftonline.com/tenant-1/v2.0",
    );
    expect(config.jwksUri).toBe(
      "https://login.microsoftonline.com/tenant-1/discovery/v2.0/keys",
    );
  });

  // The whole point of the finding: an env-var regression must not reopen the API.
  it("is misconfigured (NOT anonymous) when the provider is set but its config is missing", () => {
    const config = resolveApiAuth({ AUTH_PROVIDER: "okta" });
    expect(config.mode).toBe("misconfigured");
    expect(config.reason).toContain("OKTA_ISSUER");
  });

  it("is misconfigured on a completely empty environment", () => {
    expect(resolveApiAuth({}).mode).toBe("misconfigured");
  });

  it("is misconfigured for an unknown provider", () => {
    const config = resolveApiAuth({ AUTH_PROVIDER: "saml" });
    expect(config.mode).toBe("misconfigured");
    expect(config.reason).toContain("saml");
  });

  it("only goes anonymous on the exact explicit opt-in", () => {
    expect(resolveApiAuth({ RECON_ALLOW_ANONYMOUS_API: "true" }).mode).toBe(
      "anonymous",
    );
    // Anything other than the exact string stays locked down.
    for (const value of ["TRUE", "1", "yes", ""]) {
      expect(resolveApiAuth({ RECON_ALLOW_ANONYMOUS_API: value }).mode).toBe(
        "misconfigured",
      );
    }
  });

  it("falls back to NEXT_PUBLIC_* only for next dev", () => {
    const config = resolveApiAuth({
      NEXT_PUBLIC_AUTH_PROVIDER: "okta",
      NEXT_PUBLIC_OKTA_ISSUER: ISSUER,
      NEXT_PUBLIC_OKTA_CLIENT_ID: CLIENT_ID,
    });
    expect(config.mode).toBe("okta");
  });
});

describe("oktaJwksUri", () => {
  it("uses <issuer>/v1/keys for a custom authorization server", () => {
    expect(oktaJwksUri("https://org.okta.com/oauth2/default")).toBe(
      "https://org.okta.com/oauth2/default/v1/keys",
    );
  });

  it("uses <issuer>/oauth2/v1/keys for the org authorization server", () => {
    expect(oktaJwksUri("https://org.okta.com")).toBe(
      "https://org.okta.com/oauth2/v1/keys",
    );
  });
});

describe("authorizeRequest", () => {
  let privateKey: CryptoKey;
  let jwk: JWK;
  let config: ApiAuthConfig;

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    jwk = await exportJWK(pair.publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";

    // Serve the JWKS from a stubbed fetch so verification is offline and deterministic.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    config = resolveApiAuth({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: ISSUER,
      OKTA_CLIENT_ID: CLIENT_ID,
    });
  });

  /** Mint an ID-token-shaped JWT, overriding claims to exercise each rejection path. */
  async function token(
    claims: Record<string, unknown> = {},
    expiry = "5m",
  ): Promise<string> {
    return new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject((claims.sub as string) ?? "00uTESTuser")
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  }

  function req(authorization?: string): Request {
    return new Request("https://app.example/api/recon/cases", {
      headers: authorization ? { authorization } : {},
    });
  }

  it("accepts a valid ID token and reports the subject", async () => {
    const result = await authorizeRequest(
      req(`Bearer ${await token()}`),
      config,
    );
    expect(result).toEqual({
      ok: true,
      mode: "okta",
      subject: "00uTESTuser",
      // No `groups` claim in the token, so no groups. An empty list is the honest answer and the one
      // that denies admin — inferring membership from an absent claim is the failure this guards.
      groups: [],
    });
  });

  it("reads group memberships from the claim the deployment names", async () => {
    // Okta and Entra disagree on the claim name and an app can be configured to release it under any
    // name at all, so the name is deployment configuration rather than a constant in this file.
    const saved = process.env.AUTH_GROUPS_CLAIM;
    process.env.AUTH_GROUPS_CLAIM = "appRoles";
    try {
      const signed = await token({ appRoles: ["recon-admin", "recon-viewer"] });
      const result = await authorizeRequest(req(`Bearer ${signed}`), config);
      expect(result).toMatchObject({
        ok: true,
        groups: ["recon-admin", "recon-viewer"],
      });
    } finally {
      if (saved === undefined) delete process.env.AUTH_GROUPS_CLAIM;
      else process.env.AUTH_GROUPS_CLAIM = saved;
    }
  });

  it("ignores non-string entries in the groups claim", async () => {
    const signed = await token({ groups: ["recon-admin", 7, null] });
    const result = await authorizeRequest(req(`Bearer ${signed}`), config);
    // A provider that emits a group object rather than a name must not produce `"[object Object]"` as a
    // group someone could then be granted by, so unusable entries are dropped rather than coerced.
    expect(result).toMatchObject({ ok: true, groups: ["recon-admin"] });
  });

  it("reports no groups when the claim is not a list", async () => {
    const signed = await token({ groups: "recon-admin" });
    const result = await authorizeRequest(req(`Bearer ${signed}`), config);
    // A single-string claim is tempting to split on commas. Not doing so is deliberate: guessing a
    // delimiter is how "recon-admin,x" or "recon-administrators" turns into admin by accident.
    expect(result).toMatchObject({ ok: true, groups: [] });
  });

  it("accepts a lowercase bearer scheme (RFC 6750 is case-insensitive)", async () => {
    const result = await authorizeRequest(
      req(`bearer ${await token()}`),
      config,
    );
    expect(result.ok).toBe(true);
  });

  it("401s with no Authorization header", async () => {
    expect(await authorizeRequest(req(), config)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("401s on a non-Bearer scheme", async () => {
    expect(
      await authorizeRequest(req("Basic dXNlcjpwYXNz"), config),
    ).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("401s on an expired token", async () => {
    // Negative expiry lands outside the 60s clock tolerance.
    const stale = await token({}, "-10m");
    expect(
      await authorizeRequest(req(`Bearer ${stale}`), config),
    ).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("401s on a token minted for a different client (aud mismatch)", async () => {
    const other = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setAudience("0oaSOMEOTHERapp")
      .setSubject("00uTESTuser")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(
      await authorizeRequest(req(`Bearer ${other}`), config),
    ).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("401s on a token from a different issuer", async () => {
    const other = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://attacker.okta.com/oauth2/default")
      .setAudience(CLIENT_ID)
      .setSubject("00uTESTuser")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(
      await authorizeRequest(req(`Bearer ${other}`), config),
    ).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it("401s on an unsigned (alg=none) token", async () => {
    const header = Buffer.from(
      JSON.stringify({ alg: "none", typ: "JWT" }),
    ).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: "00uTESTuser",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");
    expect(
      await authorizeRequest(req(`Bearer ${header}.${body}.`), config),
    ).toMatchObject({ ok: false, status: 401 });
  });

  it("503s (never 200) when the configuration is unusable", async () => {
    const result = await authorizeRequest(req(`Bearer whatever`), {
      mode: "misconfigured",
      reason: "OKTA_ISSUER is unset",
    });
    expect(result).toMatchObject({ ok: false, status: 503 });
    expect(result.ok === false && result.message).toContain("OKTA_ISSUER");
  });

  it("503s (not 401) when the identity provider is unreachable", async () => {
    const saved = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    try {
      // A fresh issuer so the cached key set from the other tests is not reused.
      const cold = resolveApiAuth({
        AUTH_PROVIDER: "okta",
        OKTA_ISSUER: "https://unreachable.okta.com/oauth2/default",
        OKTA_CLIENT_ID: CLIENT_ID,
      });
      const result = await authorizeRequest(
        req(`Bearer ${await token()}`),
        cold,
      );
      expect(result).toMatchObject({ ok: false, status: 503 });
    } finally {
      globalThis.fetch = saved;
    }
  });

  it("allows through in anonymous mode without a token", async () => {
    expect(await authorizeRequest(req(), { mode: "anonymous" })).toEqual({
      ok: true,
      mode: "anonymous",
      subject: "anonymous",
      // No RECON_ADMIN_GROUP in the test environment, so no group to grant.
      groups: [],
    });
  });

  it("grants the configured admin group in anonymous mode", async () => {
    // `RECON_ALLOW_ANONYMOUS_API=true` already opens the whole BFF, so withholding the group here would
    // buy no safety and would make the Config tab impossible to work on locally.
    const saved = process.env.RECON_ADMIN_GROUP;
    process.env.RECON_ADMIN_GROUP = "recon-admin";
    try {
      expect(
        await authorizeRequest(req(), { mode: "anonymous" }),
      ).toMatchObject({ ok: true, groups: ["recon-admin"] });
    } finally {
      if (saved === undefined) delete process.env.RECON_ADMIN_GROUP;
      else process.env.RECON_ADMIN_GROUP = saved;
    }
  });
});

/**
 * BFF authorization for both apps (live-QA P0-2). The security property under test is
 * deny-by-default: no configuration and no token must never resolve to "allowed".
 *
 * Runs on the node environment, not the suite's default jsdom: this is server-side proxy code, and
 * under jsdom jose's `payload instanceof Uint8Array` check fails because the encoder and the global
 * constructor come from different realms.
 */
// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

import {
  anonymousGroups,
  authorizeRequest,
  cognitoIssuer,
  groupsFrom,
  isAnonymousEnabled,
  oktaJwksUri,
  resolveApiAuth,
  type ApiAuthConfig,
} from "@/lib/api-auth";

import { scopedEnv } from "../helpers/env";
import {
  clearAuthEnv,
  restoreAuthEnv,
  setAuthEnv,
  snapshotAuthEnv,
} from "./auth/testEnv";

const ISSUER = "https://integrator-1234567.okta.com/oauth2/default";
const CLIENT_ID = "0oaTESTclientid";

/** Fictional pool coordinates. Real ones belong in a task definition, never in a repository. */
const POOL_ID = "us-east-1_TESTpool";
const POOL_CLIENT_ID = "1example23clientid456";
const POOL_ISSUER = `https://cognito-idp.us-east-1.amazonaws.com/${POOL_ID}`;

/** The shell-wide switch first, then the two app-specific names it superseded. */
const ANONYMOUS_SWITCH_NAMES = [
  "ALLOW_ANONYMOUS_API",
  "RECON_ALLOW_ANONYMOUS_API",
  "PIPELINE_ALLOW_ANONYMOUS_API",
] as const;

describe("resolveApiAuth", () => {
  it("resolves cognito to the pool's issuer, JWKS and app client id", () => {
    const config = resolveApiAuth({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: POOL_ID,
      COGNITO_CLIENT_ID: POOL_CLIENT_ID,
      AWS_REGION: "us-east-1",
    });
    expect(config).toEqual({
      mode: "cognito",
      issuer: POOL_ISSUER,
      jwksUri: `${POOL_ISSUER}/.well-known/jwks.json`,
      audience: POOL_CLIENT_ID,
    });
  });

  it("builds the issuer from the region, not from the hosted UI domain", () => {
    // The hosted UI domain is where the BROWSER signs in. A deployment that puts it in the pool-id
    // variable fails every verification with an issuer mismatch, so the issuer is derived here.
    expect(cognitoIssuer("eu-west-2", POOL_ID)).toBe(
      `https://cognito-idp.eu-west-2.amazonaws.com/${POOL_ID}`,
    );
    const config = resolveApiAuth({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: POOL_ID,
      COGNITO_CLIENT_ID: POOL_CLIENT_ID,
      AWS_REGION: "eu-west-2",
    });
    expect(config.issuer).toBe(
      `https://cognito-idp.eu-west-2.amazonaws.com/${POOL_ID}`,
    );
  });

  it("defaults the region the way the rest of the BFF does", () => {
    const config = resolveApiAuth({
      AUTH_PROVIDER: "cognito",
      COGNITO_USER_POOL_ID: POOL_ID,
      COGNITO_CLIENT_ID: POOL_CLIENT_ID,
    });
    expect(config.issuer).toBe(POOL_ISSUER);
  });

  it.each([
    ["the pool id", { COGNITO_CLIENT_ID: POOL_CLIENT_ID }],
    ["the client id", { COGNITO_USER_POOL_ID: POOL_ID }],
    ["both", {}],
  ])(
    "is misconfigured (a 503, never an open door) when %s is missing",
    (_label, partial) => {
      const config = resolveApiAuth({ AUTH_PROVIDER: "cognito", ...partial });
      expect(config.mode).toBe("misconfigured");
      // Both names, like the okta and entra branches: the 503 body is where an operator finds out
      // which variable the deploy dropped.
      expect(config.reason).toContain("COGNITO_USER_POOL_ID");
      expect(config.reason).toContain("COGNITO_CLIENT_ID");
    },
  );

  it("treats a blank pool id or client id as unset", () => {
    // A task definition that declares the variable with an empty value must not resolve to an
    // issuer ending in a slash and then reject every token for an issuer mismatch.
    expect(
      resolveApiAuth({
        AUTH_PROVIDER: "cognito",
        COGNITO_USER_POOL_ID: "   ",
        COGNITO_CLIENT_ID: POOL_CLIENT_ID,
      }).mode,
    ).toBe("misconfigured");
  });

  it("defaults an unset AUTH_PROVIDER to cognito", () => {
    // The mirror of the browser's default in lib/auth/provider.ts. If these two disagreed, the app
    // would sign in with one provider and have every call rejected by the other.
    const config = resolveApiAuth({
      COGNITO_USER_POOL_ID: POOL_ID,
      COGNITO_CLIENT_ID: POOL_CLIENT_ID,
    });
    expect(config.mode).toBe("cognito");
    expect(config.audience).toBe(POOL_CLIENT_ID);
  });

  it("says the provider was DEFAULTED, not named, when nothing at all is configured", () => {
    // Same 503 either way; different next step. An operator who wrote AUTH_PROVIDER=cognito has a
    // missing variable; a laptop that wrote nothing wants to hear about the anonymous switch.
    const named = resolveApiAuth({ AUTH_PROVIDER: "cognito" }).reason ?? "";
    const defaulted = resolveApiAuth({}).reason ?? "";
    expect(named).toContain("AUTH_PROVIDER=cognito");
    expect(named).not.toContain("ALLOW_ANONYMOUS_API");
    expect(defaulted).toContain("AUTH_PROVIDER is unset");
    expect(defaulted).toContain("ALLOW_ANONYMOUS_API=true");
  });

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

  // One server hosts both apps, so one switch opens both. The two app-specific names predate the
  // shell and stay so existing `.env.local` files and dev task definitions keep working unchanged.
  it.each(ANONYMOUS_SWITCH_NAMES)("goes anonymous on %s=true", (name) => {
    expect(resolveApiAuth({ [name]: "true" }).mode).toBe("anonymous");
  });

  it.each(ANONYMOUS_SWITCH_NAMES)("only goes anonymous on the exact string for %s", (name) => {
    // Anything other than the exact string stays locked down.
    for (const value of ["TRUE", "1", "yes", ""]) {
      expect(resolveApiAuth({ [name]: value }).mode).toBe("misconfigured");
    }
  });

  it("lets the anonymous switch win over a configured browser provider", () => {
    // The normal dev setup: NEXT_PUBLIC_AUTH_PROVIDER tells the BROWSER which sign-in to render while
    // the server is opened for local work. That is not a conflict to report as misconfigured.
    expect(
      resolveApiAuth({ ALLOW_ANONYMOUS_API: "true", NEXT_PUBLIC_AUTH_PROVIDER: "entra" }).mode,
    ).toBe("anonymous");
  });

  it("names the shell-wide switch, not an app-specific one, when nothing is configured", () => {
    const { reason } = resolveApiAuth({});
    expect(reason).toContain("ALLOW_ANONYMOUS_API=true");
    expect(reason).not.toContain("RECON_ALLOW_ANONYMOUS_API");
    expect(reason).not.toContain("PIPELINE_ALLOW_ANONYMOUS_API");
  });

  it("falls back to NEXT_PUBLIC_* only for next dev", () => {
    const config = resolveApiAuth({
      NEXT_PUBLIC_AUTH_PROVIDER: "okta",
      NEXT_PUBLIC_OKTA_ISSUER: ISSUER,
      NEXT_PUBLIC_OKTA_CLIENT_ID: CLIENT_ID,
    });
    expect(config.mode).toBe("okta");
  });

  it("falls back to NEXT_PUBLIC_COGNITO_* for next dev too", () => {
    // `next dev` loads .env.local into the SERVER process, so the browser's copies are all it has.
    const config = resolveApiAuth({
      NEXT_PUBLIC_AUTH_PROVIDER: "cognito",
      NEXT_PUBLIC_COGNITO_USER_POOL_ID: POOL_ID,
      NEXT_PUBLIC_COGNITO_CLIENT_ID: POOL_CLIENT_ID,
      NEXT_PUBLIC_AWS_REGION: "us-east-1",
    });
    expect(config).toMatchObject({
      mode: "cognito",
      issuer: POOL_ISSUER,
      audience: POOL_CLIENT_ID,
    });
  });
});

describe("groupsFrom", () => {
  const payload = {
    groups: ["okta-group"],
    "cognito:groups": ["recon-admins"],
    "custom:groups": ["federated-desk"],
  };

  it("reads `groups` when no mode is given", () => {
    expect(groupsFrom(payload, {})).toEqual(["okta-group"]);
  });

  it.each(["okta", "entra"] as const)(
    "still reads `groups` in %s mode",
    (mode) => {
      // The pre-Cognito behaviour, unchanged: these two deployments must see exactly what they saw.
      expect(groupsFrom(payload, {}, mode)).toEqual(["okta-group"]);
    },
  );

  it("reads `cognito:groups` in cognito mode", () => {
    // A user pool emits the reserved claim and will not let you rename it, so the default follows
    // the provider rather than making every Cognito deployment set a variable.
    expect(groupsFrom(payload, {}, "cognito")).toEqual(["recon-admins"]);
  });

  it("lets an explicit AUTH_GROUPS_CLAIM win over the per-provider default", () => {
    // The federated case: a pool can map an incoming SAML/OIDC group attribute to a custom claim
    // rather than to the reserved one, and that deployment must be able to say so.
    const env = { AUTH_GROUPS_CLAIM: "custom:groups" };
    expect(groupsFrom(payload, env, "cognito")).toEqual(["federated-desk"]);
    expect(groupsFrom(payload, env, "okta")).toEqual(["federated-desk"]);
  });

  it("reports no groups when the named claim is absent", () => {
    expect(groupsFrom({ groups: ["x"] }, {}, "cognito")).toEqual([]);
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

describe("isAnonymousEnabled", () => {
  it("is off on an empty environment", () => {
    expect(isAnonymousEnabled({})).toBe(false);
  });

  it.each(ANONYMOUS_SWITCH_NAMES)("is on for %s=true and only for the exact string", (name) => {
    expect(isAnonymousEnabled({ [name]: "true" })).toBe(true);
    expect(isAnonymousEnabled({ [name]: "True" })).toBe(false);
    expect(isAnonymousEnabled({ [name]: "1" })).toBe(false);
  });
});

describe("anonymousGroups", () => {
  it("grants every configured app group when ANONYMOUS_GROUPS is unset", () => {
    // A local run without an identity provider should see every app and every admin surface; the
    // switch has already opened the whole BFF, so withholding the groups would buy no safety.
    const groups = anonymousGroups({
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
    });
    expect([...groups].sort()).toEqual(["deal-desk", "deal-desk-admins", "recon-admin"]);
  });

  it("grants nothing when no app group is configured", () => {
    expect(anonymousGroups({})).toEqual([]);
  });

  it("uses ANONYMOUS_GROUPS as the whole list when set, trimming each name", () => {
    // The configured groups are ignored, not merged: the point is to preview a NARROWER user.
    expect(
      anonymousGroups({
        ANONYMOUS_GROUPS: " deal-desk , recon-users ,",
        RECON_ADMIN_GROUP: "recon-admin",
      }),
    ).toEqual(["deal-desk", "recon-users"]);
  });

  it("de-duplicates a repeated name", () => {
    expect(anonymousGroups({ ANONYMOUS_GROUPS: "desk,desk" })).toEqual(["desk"]);
  });

  it("treats a blank ANONYMOUS_GROUPS as unset", () => {
    // Consistent with how every other group variable is read: declared-but-empty means "not set".
    // A caller in NO groups is previewed by naming a group no app is configured with instead.
    expect(anonymousGroups({ ANONYMOUS_GROUPS: "  , ", RECON_ADMIN_GROUP: "recon-admin" })).toEqual([
      "recon-admin",
    ]);
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

  // The Cognito path, which is the DEFAULT provider. Same verifier, one extra claim check, and a
  // different default group claim.
  describe("cognito mode", () => {
    let cognitoConfig: ApiAuthConfig;
    const env = scopedEnv(["AUTH_GROUPS_CLAIM"]);

    beforeAll(() => {
      cognitoConfig = resolveApiAuth({
        AUTH_PROVIDER: "cognito",
        COGNITO_USER_POOL_ID: POOL_ID,
        COGNITO_CLIENT_ID: POOL_CLIENT_ID,
        AWS_REGION: "us-east-1",
      });
    });

    beforeEach(() => env.clear());
    afterAll(() => env.restore());

    /**
     * Mint a token signed by the same test key but stamped as the user pool would stamp it.
     *
     * `token_use` defaults to "id" because that is what the app sends; the cases below override it to
     * exercise the check that keeps an access token out.
     */
    async function poolToken(
      claims: Record<string, unknown> = {},
      audience: string | undefined = POOL_CLIENT_ID,
    ): Promise<string> {
      const jwt = new SignJWT({ token_use: "id", ...claims })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(POOL_ISSUER)
        .setSubject((claims.sub as string) ?? "11111111-2222-3333-4444-555555555555")
        .setIssuedAt()
        .setExpirationTime("5m");
      // An access token carries no `aud` at all, so the audience has to be omittable here.
      if (audience !== undefined) jwt.setAudience(audience);
      return jwt.sign(privateKey);
    }

    it("accepts a valid pool ID token and reports the subject", async () => {
      const result = await authorizeRequest(
        req(`Bearer ${await poolToken()}`),
        cognitoConfig,
      );
      expect(result).toEqual({
        ok: true,
        mode: "cognito",
        subject: "11111111-2222-3333-4444-555555555555",
        groups: [],
      });
    });

    it("reads group membership from cognito:groups by default", async () => {
      const signed = await poolToken({
        "cognito:groups": ["recon-admins", "deal-desk"],
        // The claim the other two providers use is present and must be ignored: under Cognito it is
        // not the reserved one, so it is not authoritative.
        groups: ["not-this-one"],
      });
      expect(
        await authorizeRequest(req(`Bearer ${signed}`), cognitoConfig),
      ).toMatchObject({ ok: true, groups: ["recon-admins", "deal-desk"] });
    });

    it("lets AUTH_GROUPS_CLAIM override cognito:groups (the federated case)", async () => {
      env.set({ AUTH_GROUPS_CLAIM: "custom:groups" });
      const signed = await poolToken({
        "custom:groups": ["federated-desk"],
        "cognito:groups": ["recon-admins"],
      });
      expect(
        await authorizeRequest(req(`Bearer ${signed}`), cognitoConfig),
      ).toMatchObject({ ok: true, groups: ["federated-desk"] });
    });

    it("401s on an ACCESS token minted for the same pool", async () => {
      // The shape that matters: a Cognito access token has NO `aud` (it carries `client_id`), is
      // signed by the same key from the same issuer, and any signed-in user can obtain one.
      const accessToken = await poolToken(
        { token_use: "access", client_id: POOL_CLIENT_ID, scope: "openid" },
        undefined,
      );
      expect(
        await authorizeRequest(req(`Bearer ${accessToken}`), cognitoConfig),
      ).toMatchObject({ ok: false, status: 401 });
    });

    it("401s on an access token even when it does carry the right aud", async () => {
      // The audience check is what rejects the real shape above, so this case removes it: it proves
      // the token_use assertion is load-bearing on its own, and would fail if someone later relaxed
      // the audience rule (a second client id, a resource-server audience) without noticing.
      const result = await authorizeRequest(
        req(`Bearer ${await poolToken({ token_use: "access" })}`),
        cognitoConfig,
      );
      expect(result).toMatchObject({ ok: false, status: 401 });
      expect(result.ok === false && result.message).toContain("token_use");
    });

    it("401s when token_use is absent altogether", async () => {
      const result = await authorizeRequest(
        req(`Bearer ${await poolToken({ token_use: undefined })}`),
        cognitoConfig,
      );
      expect(result).toMatchObject({ ok: false, status: 401 });
    });

    it("401s on an ID token minted for a different app client", async () => {
      const other = await poolToken({}, "9other88clientid777");
      expect(
        await authorizeRequest(req(`Bearer ${other}`), cognitoConfig),
      ).toMatchObject({ ok: false, status: 401 });
    });

    it("401s on an ID token from a different user pool", async () => {
      const other = await new SignJWT({ token_use: "id" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer("https://cognito-idp.us-east-1.amazonaws.com/us-east-1_OTHERpool")
        .setAudience(POOL_CLIENT_ID)
        .setSubject("11111111-2222-3333-4444-555555555555")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      expect(
        await authorizeRequest(req(`Bearer ${other}`), cognitoConfig),
      ).toMatchObject({ ok: false, status: 401 });
    });

    it("503s (never 200) when the pool id or client id is missing", async () => {
      // End to end from the environment: a deploy that lost a variable must break visibly.
      const result = await authorizeRequest(
        req(`Bearer ${await poolToken()}`),
        resolveApiAuth({ AUTH_PROVIDER: "cognito", COGNITO_CLIENT_ID: POOL_CLIENT_ID }),
      );
      expect(result).toMatchObject({ ok: false, status: 503 });
      expect(result.ok === false && result.message).toContain("COGNITO_USER_POOL_ID");
    });
  });

  describe("anonymous mode", () => {
    // Group names are read from process.env at call time (they are runtime deployment facts), so
    // these cases set the real environment and put it back afterwards.
    const saved = snapshotAuthEnv();
    beforeEach(() => clearAuthEnv());
    afterAll(() => restoreAuthEnv(saved));

    it("allows through without a token, with no groups when none are configured", async () => {
      expect(await authorizeRequest(req(), { mode: "anonymous" })).toEqual({
        ok: true,
        mode: "anonymous",
        subject: "anonymous",
        groups: [],
      });
    });

    it("grants every configured app group", async () => {
      // `ALLOW_ANONYMOUS_API=true` already opens the whole BFF, so withholding the groups would buy no
      // safety and would make both apps' admin surfaces impossible to work on locally.
      setAuthEnv({
        RECON_ADMIN_GROUP: "recon-admin",
        PIPELINE_ACCESS_GROUP: "deal-desk",
        PIPELINE_ADMIN_GROUP: "deal-desk-admins",
      });
      const result = await authorizeRequest(req(), { mode: "anonymous" });
      expect(result.ok).toBe(true);
      expect(result.ok && [...result.groups].sort()).toEqual([
        "deal-desk",
        "deal-desk-admins",
        "recon-admin",
      ]);
    });

    it("honours ANONYMOUS_GROUPS as the whole group list", async () => {
      setAuthEnv({ ANONYMOUS_GROUPS: " recon-users ,deal-desk", RECON_ADMIN_GROUP: "recon-admin" });
      expect(await authorizeRequest(req(), { mode: "anonymous" })).toMatchObject({
        ok: true,
        groups: ["recon-users", "deal-desk"],
      });
    });

    it("resolves anonymous mode from the environment when no config is injected", async () => {
      // The production call shape: `authorizeRequest(request)` with the config resolved from
      // process.env at call time, which is what the proxy and every route handler do.
      setAuthEnv({ RECON_ALLOW_ANONYMOUS_API: "true", RECON_ADMIN_GROUP: "recon-admin" });
      expect(await authorizeRequest(req())).toEqual({
        ok: true,
        mode: "anonymous",
        subject: "anonymous",
        groups: ["recon-admin"],
      });
    });
  });
});

// @vitest-environment node
/**
 * The gate, end to end.
 *
 * Runs the real `proxy` against the real verifier and registry, driven by `process.env`, because the
 * property under test is the WIRING: a request to each prefix is authenticated first, then checked
 * against that app's group, and `/api/me` stops after the first check. Anonymous mode plus
 * `ANONYMOUS_GROUPS` stands in for a signed token — from the group list onwards it is the same code
 * path, and it is exactly what a developer uses to preview a restricted user locally. Token
 * verification itself is covered in `api-auth.test.ts`.
 *
 * Node environment: `api-auth` pulls in jose, whose `instanceof Uint8Array` check fails across realms
 * under jsdom.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { config, proxy } from "@/proxy";

import { clearAuthEnv, restoreAuthEnv, setAuthEnv, snapshotAuthEnv } from "./testEnv";

const PATHS = ["/api/recon/cases", "/api/pipeline/deals", "/api/me"] as const;

const DENIED_RECON =
  "no access to Trade Reconciliation: membership of the recon-users group is required";
const DENIED_PIPELINE =
  "no access to Deal Pipeline: membership of the deal-desk group is required";

const saved = snapshotAuthEnv();
beforeEach(() => clearAuthEnv());
afterAll(() => restoreAuthEnv(saved));

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://app.example${path}`, { headers });
}

async function body(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe("proxy matcher", () => {
  it("declares exactly the two app BFFs and the shell's identity route", () => {
    // Literal, not derived from APPS: Next reads the matcher at build time and ignores computed values.
    expect(config.matcher).toEqual(["/api/recon/:path*", "/api/pipeline/:path*", "/api/me"]);
  });
});

describe("proxy authentication", () => {
  it("401s every prefix, with a Bearer challenge, when no token is presented", async () => {
    setAuthEnv({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
    });
    for (const path of PATHS) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBe("Bearer");
      expect((await body(res)).error, path).toContain("Authorization");
    }
  });

  it("503s every prefix, without a challenge, when the server is misconfigured", async () => {
    // Deny by default: an empty environment is a broken deploy, never an open one — and not a "sign
    // in again" either, since no token would help.
    for (const path of PATHS) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(503);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
      expect((await body(res)).error, path).toContain("ALLOW_ANONYMOUS_API=true");
    }
  });
});

describe("proxy per-app access", () => {
  it("passes an anonymous caller through to every prefix when no access group is set", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    for (const path of PATHS) {
      const res = await proxy(request(path));
      expect(res.status, path).toBe(200);
      // `NextResponse.next()` is how a proxy says "continue to the handler".
      expect(res.headers.get("x-middleware-next"), path).toBe("1");
    }
  });

  it("403s an app-prefixed call from outside that app's access group, with the exact message", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
    });
    const res = await proxy(request("/api/recon/cases"));
    expect(res.status).toBe(403);
    // Not a 401: the caller IS authenticated, and a challenge would send the client into a sign-in
    // loop that can never succeed.
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await body(res)).toEqual({ error: DENIED_RECON });
  });

  it("leaves the other app open when only one is restricted", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
    });
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(200);
  });

  it("lets /api/me through for a caller who may use no app", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(403);
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(403);
    expect((await proxy(request("/api/me"))).status).toBe(200);
  });

  it("admits a member of the access group", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "recon-users",
      RECON_ACCESS_GROUP: "recon-users",
    });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
  });

  it("admits an admin who is not in the access group", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "recon-admin",
      RECON_ACCESS_GROUP: "recon-users",
      RECON_ADMIN_GROUP: "recon-admin",
    });
    expect((await proxy(request("/api/recon/cases/1"))).status).toBe(200);
  });

  it("restricts each app by its own group", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "recon-users",
      RECON_ACCESS_GROUP: "recon-users",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
    const denied = await proxy(request("/api/pipeline/deals"));
    expect(denied.status).toBe(403);
    expect(await body(denied)).toEqual({ error: DENIED_PIPELINE });
  });

  it("guards the bare prefix as well as nested paths", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
    });
    expect((await proxy(request("/api/recon"))).status).toBe(403);
  });

  it("honours the legacy app-specific switch for the whole shell", async () => {
    // A `.env.local` written for the pipeline app alone still opens BOTH BFFs: there is one server,
    // so a per-app switch never meant anything narrower.
    setAuthEnv({ PIPELINE_ALLOW_ANONYMOUS_API: "true" });
    for (const path of PATHS) {
      expect((await proxy(request(path))).status, path).toBe(200);
    }
  });
});

describe("proxy app enablement", () => {
  it("403s the pipeline prefix on a recon-only console and leaves everything else alone", async () => {
    // Terraform renders PIPELINE_ENABLED=false when enable_deal_pipeline is false. The pipeline's
    // routes must not run at all there: several of them would otherwise read the shared container's
    // recon resources, and the rest 500 on tables that do not exist.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", PIPELINE_ENABLED: "false" });
    const denied = await proxy(request("/api/pipeline/deals"));
    expect(denied.status).toBe(403);
    expect(await body(denied)).toEqual({ error: "Deal Pipeline is not enabled on this deployment" });
    expect((await proxy(request("/api/pipeline"))).status).toBe(403);
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
    expect((await proxy(request("/api/me"))).status).toBe(200);
  });

  it("403s a disabled app even for a caller in its admin group", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      PIPELINE_ENABLED: "false",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
    });
    expect((await proxy(request("/api/pipeline/config"))).status).toBe(403);
  });

  it.each(["true", "1", ""])("keeps the pipeline reachable when PIPELINE_ENABLED is %j", async (value) => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", PIPELINE_ENABLED: value });
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(200);
  });
});

describe("proxy under REQUIRE_ACCESS_GROUPS", () => {
  it("403s both apps for a caller in no group when their access groups are unset", async () => {
    // The composed deployment sets this, so a blank group can never mean "both desks may use it".
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      REQUIRE_ACCESS_GROUPS: "true",
    });
    const denied = await proxy(request("/api/recon/cases"));
    expect(denied.status).toBe(403);
    expect((await body(denied)).error).toContain("RECON_ACCESS_GROUP is not configured");
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(403);
    // Still answers: the shell needs to be told the viewer may use nothing.
    expect((await proxy(request("/api/me"))).status).toBe(200);
  });

  it("admits the admin group and a configured access group as before", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "recon-admin,deal-desk",
      REQUIRE_ACCESS_GROUPS: "true",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(200);
  });
});

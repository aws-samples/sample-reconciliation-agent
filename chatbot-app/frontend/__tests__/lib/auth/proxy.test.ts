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
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { invalidate } from "@/lib/console/settings";
import { config, proxy } from "@/proxy";

import { createFakeSsm, type FakeSsm, type FakeSsmCommand } from "../console/fakeSsm";
import { clearAuthEnv, restoreAuthEnv, setAuthEnv, snapshotAuthEnv } from "./testEnv";

// Parameter Store is the one dependency faked: the overlay cases below store a group there, and every
// other case runs with the prefix unset, where the gate must never reach for it. The whole mock is
// built inside `vi.hoisted` because the proxy is imported statically above, so the factory runs before
// any other top-level binding in this file is initialised.
const ssm = vi.hoisted(() => {
  const send = vi.fn();
  const tag = (cmd: string) => vi.fn().mockImplementation((input: object) => ({ __cmd: cmd, ...input }));
  return {
    send,
    module: {
      SSMClient: vi.fn().mockImplementation(() => ({ send })),
      GetParameterCommand: tag("Get"),
      GetParametersByPathCommand: tag("GetByPath"),
      PutParameterCommand: tag("Put"),
      DeleteParameterCommand: tag("Delete"),
    },
  };
});
vi.mock("@aws-sdk/client-ssm", () => ssm.module);
const ssmSend = ssm.send;

const PATHS = ["/api/recon/cases", "/api/pipeline/deals", "/api/console/settings", "/api/me"] as const;

const DENIED_RECON =
  "no access to Trade Reconciliation: membership of the recon-users group is required";
const DENIED_PIPELINE =
  "no access to Deal Pipeline: membership of the deal-desk group is required";

const PREFIX = "/recon-test/console";
let fake: FakeSsm;

const saved = snapshotAuthEnv();
beforeEach(() => {
  clearAuthEnv();
  fake = createFakeSsm();
  ssmSend.mockReset();
  ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
  invalidate();
});
afterAll(() => restoreAuthEnv(saved));

function request(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://app.example${path}`, { headers });
}

async function body(res: Response): Promise<{ error?: string }> {
  return (await res.json()) as { error?: string };
}

describe("proxy matcher", () => {
  it("declares exactly the two app BFFs, the console routes and the shell's identity route", () => {
    // Literal, not derived from APPS: Next reads the matcher at build time and ignores computed values.
    expect(config.matcher).toEqual([
      "/api/recon/:path*",
      "/api/pipeline/:path*",
      "/api/console/:path*",
      "/api/me",
    ]);
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

describe("proxy and the console routes", () => {
  it("admits any authenticated caller to /api/console/*, leaving the admin check to the route", async () => {
    // Like `/api/me`: the preferences route must answer for a caller who may use no app, and the
    // settings route refuses non-admins itself with a 403 that names CONSOLE_ADMIN_GROUP.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    expect((await proxy(request("/api/console/settings"))).status).toBe(200);
    expect((await proxy(request("/api/console/preferences"))).status).toBe(200);
    expect((await proxy(request("/api/console/access-check?groups=x"))).status).toBe(200);
  });

  it("never touches Parameter Store when the layer is not configured", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", RECON_ACCESS_GROUP: "recon-users" });
    for (const path of PATHS) await proxy(request(path));
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

describe("proxy with the stored overlay", () => {
  it("denies with a stored access group a caller the environment alone would have admitted", async () => {
    // No RECON_ACCESS_GROUP in the environment: recon is open. The stored value closes it, and the 403
    // names the stored group, which is what the operator typed on the Settings screen.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "nobody", CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "access/recon/access-group": "recon-users" });
    const denied = await proxy(request("/api/recon/cases"));
    expect(denied.status).toBe(403);
    expect(await body(denied)).toEqual({ error: DENIED_RECON });
    // The other app and the non-app routes are untouched.
    expect((await proxy(request("/api/pipeline/deals"))).status).toBe(200);
    expect((await proxy(request("/api/me"))).status).toBe(200);
  });

  it("lets a stored group beat the environment's, in both directions", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "desk-b",
      CONSOLE_SETTINGS_PREFIX: PREFIX,
      RECON_ACCESS_GROUP: "desk-a",
    });
    // Env says desk-a; the store says desk-b. The caller is in desk-b, so the store admits them.
    fake.seed(PREFIX, { "access/recon/access-group": "desk-b" });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
    // Swap: the store now names desk-a, and the same caller is refused even though env never changed.
    fake.store.set(`${PREFIX}/access/recon/access-group`, "desk-a");
    invalidate();
    expect((await proxy(request("/api/recon/cases"))).status).toBe(403);
  });

  it("admits a member of a stored admin group to an app the stored access group closes", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "recon-admin", CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "access/recon/access-group": "recon-users", "access/recon/admin-group": "recon-admin" });
    expect((await proxy(request("/api/recon/cases/1"))).status).toBe(200);
  });

  it("switches an app off from the store", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "apps/pipeline/enabled": "false" });
    const denied = await proxy(request("/api/pipeline/deals"));
    expect(denied.status).toBe(403);
    expect(await body(denied)).toEqual({ error: "Deal Pipeline is not enabled on this deployment" });
    expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
  });

  it("cannot widen access past the environment-only switches", async () => {
    // REQUIRE_ACCESS_GROUPS comes from the environment and nothing stored can unset it, so a blank
    // stored access group still means admins-only.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      REQUIRE_ACCESS_GROUPS: "true",
      CONSOLE_SETTINGS_PREFIX: PREFIX,
    });
    fake.store.set(`${PREFIX}/access/REQUIRE_ACCESS_GROUPS`, "false");
    fake.seed(PREFIX, { "access/recon/access-group": "" });
    const denied = await proxy(request("/api/recon/cases"));
    expect(denied.status).toBe(403);
    expect((await body(denied)).error).toContain("RECON_ACCESS_GROUP is not configured");
  });

  it("falls back to the environment when Parameter Store is unreachable", async () => {
    // Fail open to env: a stored-only restriction is not enforced during the outage window, but the
    // deployment's own configuration still is, and nobody is locked out by an SSM hiccup.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      CONSOLE_SETTINGS_PREFIX: PREFIX,
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ssmSend.mockRejectedValue(new Error("ThrottlingException"));
      expect((await proxy(request("/api/recon/cases"))).status).toBe(200);
      expect((await proxy(request("/api/pipeline/deals"))).status).toBe(403);
      expect((await proxy(request("/api/me"))).status).toBe(200);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

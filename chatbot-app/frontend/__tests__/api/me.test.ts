// @vitest-environment node
/**
 * `/api/me`: what the shell learns about the viewer.
 *
 * Real verifier, real registry, driven by `process.env`, because the contract under test is the body
 * SHAPE the shell consumes (`Viewer` in `lib/auth/apps.ts`) and the wiring from the anonymous group
 * list through `resolveAppAccess`. Anonymous mode plus `ANONYMOUS_GROUPS` stands in for a signed
 * token, and is also the exact configuration a developer uses to preview a restricted user.
 *
 * Node environment: `api-auth` pulls in jose, whose `instanceof Uint8Array` check fails across realms
 * under jsdom.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, type MeResponse } from "@/app/api/me/route";
import { isAppAdmin } from "@/lib/auth/app-admin";
import type { Viewer } from "@/lib/auth/apps";
import { invalidate, preferencesParameterName } from "@/lib/console/settings";
import { isReconAdmin } from "@/lib/reconAdmin";

import {
  clearAuthEnv,
  restoreAuthEnv,
  setAuthEnv,
  snapshotAuthEnv,
} from "../lib/auth/testEnv";
import { createFakeSsm, type FakeSsm, type FakeSsmCommand } from "../lib/console/fakeSsm";

// Parameter Store is the one dependency faked: the console fields below read the stored layer, and
// every other case runs with the prefix unset, where the route must never reach for it. The whole
// mock is built inside `vi.hoisted` because the route is imported statically above, so the factory
// runs before any other top-level binding in this file is initialised.
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

function get(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request("https://app.example/api/me", { headers }));
}

describe("GET /api/me", () => {
  it("returns exactly the Viewer shape plus the console fields, and nothing else", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    const res = await get();
    expect(res.status).toBe(200);
    const viewer = (await res.json()) as MeResponse;
    // Pinned key set: the shell types this body, and a stray `isAdmin` here would tempt a consumer to
    // read one app's flag as the whole answer.
    expect(Object.keys(viewer).sort()).toEqual(["apps", "console", "groups", "mode", "preferences", "subject"]);
    expect(Object.keys(viewer.apps).sort()).toEqual(["pipeline", "recon"]);
    for (const app of Object.values(viewer.apps)) {
      expect(Object.keys(app).sort()).toEqual(["access", "admin"]);
    }
    expect(Object.keys(viewer.console).sort()).toEqual(["admin", "configured", "organizationLabel"]);
    // No stored layer: nothing was asked of Parameter Store.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("in anonymous mode, reports every configured app as accessible and administered", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      RECON_ACCESS_GROUP: "recon-users",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
    });
    const viewer = (await (await get()).json()) as Viewer;
    expect(viewer.subject).toBe("anonymous");
    expect(viewer.mode).toBe("anonymous");
    expect([...viewer.groups].sort()).toEqual(["deal-desk-admins", "recon-admin", "recon-users"]);
    expect(viewer.apps).toEqual({
      recon: { access: true, admin: true },
      pipeline: { access: true, admin: true },
    });
  });

  it("reports a restricted viewer: denied on one app, a plain user on the other", async () => {
    // ANONYMOUS_GROUPS=deal-desk is how a developer previews the shell as a pipeline user who has no
    // recon access; the body is what drives the rail to hide recon and the pipeline to hide its
    // admin surfaces.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "deal-desk",
      RECON_ACCESS_GROUP: "recon-users",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
    });
    const res = await get();
    // Still 200: a viewer with reduced access is an answer, not an error. The proxy admits `/api/me`
    // on authentication alone for exactly this reason.
    expect(res.status).toBe(200);
    const viewer = (await res.json()) as Viewer;
    expect(viewer.groups).toEqual(["deal-desk"]);
    expect(viewer.apps).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: true, admin: false },
    });
  });

  it("answers for a viewer who may use no app at all", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "nobody",
      RECON_ACCESS_GROUP: "recon-users",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(((await res.json()) as Viewer).apps).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: false, admin: false },
    });
  });

  it("is open and not admin for every app when no group is configured", async () => {
    // A deployment that predates the shell: no access groups, no admin groups. Everyone may use both
    // apps and nobody administers either, which is what those deployments already did.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    const viewer = (await (await get()).json()) as Viewer;
    expect(viewer.groups).toEqual([]);
    expect(viewer.apps).toEqual({
      recon: { access: true, admin: false },
      pipeline: { access: true, admin: false },
    });
  });

  it("hides a disabled app from everyone, including its admins", async () => {
    // The recon-only upgrade: Terraform renders PIPELINE_ENABLED=false. The body is what drives the
    // landing page's single-app redirect and keeps Deal Pipeline out of the rail, so `access` AND
    // `admin` must both be false even for a viewer who holds the pipeline admin group.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      PIPELINE_ENABLED: "false",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
    });
    const viewer = (await (await get()).json()) as Viewer;
    expect(viewer.groups).toContain("deal-desk-admins");
    expect(viewer.apps).toEqual({
      recon: { access: true, admin: true },
      pipeline: { access: false, admin: false },
    });
  });

  it("closes an app with no access group to non-admins under REQUIRE_ACCESS_GROUPS", async () => {
    // The composed deployment: a deal-desk user must not see (or reach) recon just because recon's
    // access group was left blank.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      ANONYMOUS_GROUPS: "deal-desk",
      REQUIRE_ACCESS_GROUPS: "true",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    const viewer = (await (await get()).json()) as Viewer;
    expect(viewer.apps).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: true, admin: false },
    });
  });

  it("agrees with the write-route helpers about a padded admin group", async () => {
    // A tfvars value with stray whitespace reaches the task verbatim. If this route trimmed and the
    // helpers did not, the rail would show an admin chip while every write route answered 403.
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      RECON_ADMIN_GROUP: "  recon-admin ",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins  ",
    });
    const viewer = (await (await get()).json()) as Viewer;
    expect(viewer.apps.recon.admin).toBe(true);
    expect(viewer.apps.pipeline.admin).toBe(true);
    expect(isReconAdmin(viewer.groups)).toBe(true);
    expect(isAppAdmin("pipeline", viewer.groups)).toBe(true);
  });

  it("401s without a token rather than inventing a viewer", async () => {
    // The route verifies for itself even though the proxy already did: a matcher change that dropped
    // `/api/me` must not turn it into an unauthenticated oracle of who is in which group.
    setAuthEnv({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
    });
    const res = await get();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("Authorization");
  });

  it("503s when authorization is misconfigured", async () => {
    const res = await get();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain("ALLOW_ANONYMOUS_API=true");
  });
});

describe("GET /api/me console fields", () => {
  it("reports the layer unconfigured, the default label and empty preferences without the prefix", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    const viewer = (await (await get()).json()) as MeResponse;
    expect(viewer.console).toEqual({
      admin: false,
      configured: false,
      organizationLabel: "Agentic Operations Console",
    });
    expect(viewer.preferences).toEqual({});
  });

  it("marks a member of CONSOLE_ADMIN_GROUP as console admin, and anonymous mode holds that group", async () => {
    // The same rule as the app admin groups: anonymous mode carries every configured group.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", CONSOLE_ADMIN_GROUP: " console-admins " });
    const viewer = (await (await get()).json()) as MeResponse;
    expect(viewer.groups).toEqual(["console-admins"]);
    expect(viewer.console.admin).toBe(true);
  });

  it("is not console admin for a restricted viewer or when the group is unset", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "recon-admin", CONSOLE_ADMIN_GROUP: "console-admins" });
    expect(((await (await get()).json()) as MeResponse).console.admin).toBe(false);
    // Unset group: anonymous mode holds every configured group, and this one is not configured.
    clearAuthEnv();
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    expect(((await (await get()).json()) as MeResponse).console.admin).toBe(false);
  });

  it("resolves the organization label from the environment when nothing is stored", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", CONSOLE_ORGANIZATION_LABEL: " Northwind Capital " });
    expect(((await (await get()).json()) as MeResponse).console.organizationLabel).toBe("Northwind Capital");
  });

  it("with the layer configured, reports it, prefers the stored label, and returns the viewer's preferences", async () => {
    setAuthEnv({
      ALLOW_ANONYMOUS_API: "true",
      CONSOLE_SETTINGS_PREFIX: PREFIX,
      CONSOLE_ORGANIZATION_LABEL: "Env Label",
    });
    fake.seed(PREFIX, { "defaults/organization-label": "Northwind Capital" });
    fake.store.set(preferencesParameterName("anonymous", PREFIX), JSON.stringify({ theme: "dark", railCollapsed: true }));
    fake.store.set(preferencesParameterName("00uSOMEONE", PREFIX), JSON.stringify({ theme: "light" }));
    const viewer = (await (await get()).json()) as MeResponse;
    expect(viewer.console).toEqual({ admin: false, configured: true, organizationLabel: "Northwind Capital" });
    // The caller's row, not the other one.
    expect(viewer.preferences).toEqual({ theme: "dark", railCollapsed: true });
  });

  it("resolves per-app access against the stored overlay", async () => {
    // A stored access group must hide the app in the rail exactly as the proxy will 403 it.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "deal-desk", CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "access/recon/access-group": "recon-users", "access/pipeline/admin-group": "deal-desk" });
    const viewer = (await (await get()).json()) as MeResponse;
    expect(viewer.apps).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: true, admin: true },
    });
  });

  it("still answers, with empty preferences, when the preferences read fails", async () => {
    // The rail can render without preferences; it cannot render without the viewer.
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", CONSOLE_SETTINGS_PREFIX: PREFIX });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ssmSend.mockImplementation(async (cmd: FakeSsmCommand) => {
        if (cmd.__cmd === "Get") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
        return fake.send(cmd);
      });
      const res = await get();
      expect(res.status).toBe(200);
      expect(((await res.json()) as MeResponse).preferences).toEqual({});
    } finally {
      warn.mockRestore();
    }
  });
});

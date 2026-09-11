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
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/me/route";
import type { Viewer } from "@/lib/auth/apps";

import {
  clearAuthEnv,
  restoreAuthEnv,
  setAuthEnv,
  snapshotAuthEnv,
} from "../lib/auth/testEnv";

const saved = snapshotAuthEnv();
beforeEach(() => clearAuthEnv());
afterAll(() => restoreAuthEnv(saved));

function get(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request("https://app.example/api/me", { headers }));
}

describe("GET /api/me", () => {
  it("returns exactly the Viewer shape and nothing else", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true" });
    const res = await get();
    expect(res.status).toBe(200);
    const viewer = (await res.json()) as Viewer;
    // Pinned key set: the shell types this body, and a stray `isAdmin` here would tempt a consumer to
    // read one app's flag as the whole answer.
    expect(Object.keys(viewer).sort()).toEqual(["apps", "groups", "mode", "subject"]);
    expect(Object.keys(viewer.apps).sort()).toEqual(["pipeline", "recon"]);
    for (const app of Object.values(viewer.apps)) {
      expect(Object.keys(app).sort()).toEqual(["access", "admin"]);
    }
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

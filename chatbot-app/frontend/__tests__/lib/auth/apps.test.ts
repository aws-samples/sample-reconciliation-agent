// @vitest-environment node
/**
 * The app registry and its access rule.
 *
 * `resolveAppAccess` is the one function every per-app decision in the shell flows through — the
 * proxy's 403, `/api/me`, the rail, the landing page — so its table is pinned here case by case. The
 * property that matters most is the compatibility one: an app whose access group is UNSET is open to
 * every authenticated user, because that is what every deployment did before the shell existed, and a
 * shell rollout must not lock out a desk that has not yet created the group.
 */
import { describe, expect, it } from "vitest";

import {
  APPS,
  allConfiguredGroups,
  appById,
  appForApiPath,
  appForPagePath,
  resolveAppAccess,
} from "@/lib/auth/apps";

/** A deployment that has restricted both apps and named both admin groups. */
const RESTRICTED = {
  RECON_ACCESS_GROUP: "recon-users",
  RECON_ADMIN_GROUP: "recon-admin",
  PIPELINE_ACCESS_GROUP: "deal-desk",
  PIPELINE_ADMIN_GROUP: "deal-desk-admins",
};

describe("APPS registry", () => {
  it("lists recon then pipeline, each with its own prefixes", () => {
    expect(APPS.map((a) => a.id)).toEqual(["recon", "pipeline"]);
    // Two apps sharing a prefix would make `appForApiPath` return whichever came first, silently
    // guarding one app's routes with the other app's group.
    expect(new Set(APPS.map((a) => a.apiPrefix)).size).toBe(APPS.length);
    expect(new Set(APPS.map((a) => a.pathPrefix)).size).toBe(APPS.length);
  });

  it("names an access and an admin variable for every app, and lands inside its own tree", () => {
    for (const app of APPS) {
      expect(app.accessGroupEnv).toMatch(/_ACCESS_GROUP$/);
      expect(app.adminGroupEnv).toMatch(/_ADMIN_GROUP$/);
      expect(app.apiPrefix).toBe(`/api${app.pathPrefix}`);
      expect(app.href.startsWith(`${app.pathPrefix}/`)).toBe(true);
    }
  });
});

describe("resolveAppAccess", () => {
  it("is open and not admin for every app when no group is configured at all", () => {
    expect(resolveAppAccess(["anything"], {})).toEqual({
      recon: { access: true, admin: false },
      pipeline: { access: true, admin: false },
    });
  });

  it("opens an app whose access group is unset to a caller with no groups", () => {
    // Only the admin group is configured: the app is open to use, and only the admin group can write.
    expect(resolveAppAccess([], { RECON_ADMIN_GROUP: "recon-admin" }).recon).toEqual({
      access: true,
      admin: false,
    });
  });

  it("admits a member of the access group as a user, not an admin", () => {
    expect(resolveAppAccess(["recon-users"], RESTRICTED).recon).toEqual({
      access: true,
      admin: false,
    });
  });

  it("admits an admin who is not in the access group: admin implies access", () => {
    // Otherwise every admin would need two memberships and a desk that forgot the second would have
    // administrators who cannot open the app they administer.
    expect(resolveAppAccess(["recon-admin"], RESTRICTED).recon).toEqual({
      access: true,
      admin: true,
    });
  });

  it("denies a caller in the wrong group", () => {
    expect(resolveAppAccess(["deal-desk"], RESTRICTED).recon).toEqual({
      access: false,
      admin: false,
    });
  });

  it("denies a caller with no groups once the access group is set", () => {
    expect(resolveAppAccess([], RESTRICTED).recon).toEqual({ access: false, admin: false });
  });

  it("resolves each app independently", () => {
    expect(resolveAppAccess(["deal-desk"], RESTRICTED)).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: true, admin: false },
    });
  });

  it("matches group names exactly", () => {
    // No case folding, no prefix matching: "recon-users-readonly" is a different group and must not
    // inherit access from a substring.
    expect(
      resolveAppAccess(["Recon-Users", "recon-users-readonly", "recon-admins"], RESTRICTED).recon,
    ).toEqual({ access: false, admin: false });
  });

  it("trims whitespace around configured names", () => {
    expect(
      resolveAppAccess(["recon-users"], { RECON_ACCESS_GROUP: "  recon-users  " }).recon.access,
    ).toBe(true);
  });

  it("reads a blank variable as unset", () => {
    // A task definition that declares the variable with an empty value must behave like one that
    // omits it, not lock everyone out (access) or let a caller with an empty group name in (admin).
    expect(
      resolveAppAccess([""], { RECON_ACCESS_GROUP: "   ", RECON_ADMIN_GROUP: "" }).recon,
    ).toEqual({ access: true, admin: false });
  });
});

describe("allConfiguredGroups", () => {
  it("returns every distinct configured group across both apps", () => {
    expect([...allConfiguredGroups(RESTRICTED)].sort()).toEqual(
      ["deal-desk", "deal-desk-admins", "recon-admin", "recon-users"].sort(),
    );
  });

  it("de-duplicates a group that serves two roles", () => {
    expect(
      allConfiguredGroups({ RECON_ACCESS_GROUP: "desk", PIPELINE_ACCESS_GROUP: "desk" }),
    ).toEqual(["desk"]);
  });

  it("skips blank values and is empty when nothing is configured", () => {
    expect(allConfiguredGroups({ RECON_ADMIN_GROUP: "  " })).toEqual([]);
    expect(allConfiguredGroups({})).toEqual([]);
  });
});

describe("appForApiPath", () => {
  it.each([
    ["/api/recon", "recon"],
    ["/api/recon/cases/1", "recon"],
    ["/api/pipeline", "pipeline"],
    ["/api/pipeline/deals/dl_1/approve", "pipeline"],
  ])("maps %s to %s", (path, id) => {
    expect(appForApiPath(path)?.id).toBe(id);
  });

  it.each(["/api/me", "/api/reconciliation", "/api/pipelines/x", "/api/session", "/recon/dashboard"])(
    "owns no app for %s",
    (path) => {
      // Segment-exact: "/api/reconciliation" must not be guarded (or opened) as the recon app.
      expect(appForApiPath(path)).toBeUndefined();
    },
  );
});

describe("appForPagePath", () => {
  it.each([
    ["/recon", "recon"],
    ["/recon/dashboard", "recon"],
    ["/pipeline/inbox/em_1", "pipeline"],
  ])("maps %s to %s", (path, id) => {
    expect(appForPagePath(path)?.id).toBe(id);
  });

  it.each(["/", "/reconx", "/api/recon/cases", "/pipelines"])("owns no app for %s", (path) => {
    expect(appForPagePath(path)).toBeUndefined();
  });
});

describe("appById", () => {
  it("finds an app by id and returns undefined for an unknown one", () => {
    expect(appById("recon")?.label).toBe("Trade Reconciliation");
    expect(appById("pipeline")?.label).toBe("Deal Pipeline");
    expect(appById("nope")).toBeUndefined();
  });
});

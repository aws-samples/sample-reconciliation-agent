// @vitest-environment node
/**
 * The app registry and its access rule.
 *
 * `resolveAppAccess` is the one function every per-app decision in the shell flows through — the
 * proxy's 403, `/api/me`, the rail, the landing page — so its table is pinned here case by case. The
 * property that matters most is the compatibility one: an app whose access group is UNSET is open to
 * every authenticated user, because that is what every deployment did before the shell existed, and a
 * shell rollout must not lock out a desk that has not yet created the group. Two switches qualify it
 * and are pinned just as carefully: `REQUIRE_ACCESS_GROUPS=true` closes an unset group to non-admins
 * (the composed deployment, where "everyone" means two desks), and an app's `enabledEnv` at exactly
 * "false" removes the app altogether (a recon-only console must not list an undeployed pipeline).
 */
import { describe, expect, it } from "vitest";

import {
  APPS,
  accessGroupFor,
  accessGroupsRequired,
  adminGroupFor,
  allConfiguredGroups,
  appById,
  appForApiPath,
  appForPagePath,
  isAppEnabled,
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

  it("makes only the pipeline an opt-in deployment", () => {
    // Recon is the console's original app and has no switch; the pipeline is `enable_deal_pipeline`
    // in Terraform, so its presence must be told to the process.
    expect(appById("recon")!.enabledEnv).toBeUndefined();
    expect(appById("pipeline")!.enabledEnv).toBe("PIPELINE_ENABLED");
  });
});

describe("isAppEnabled", () => {
  it("is always on for an app with no enablement variable", () => {
    expect(isAppEnabled("recon", { PIPELINE_ENABLED: "false" })).toBe(true);
  });

  it.each([undefined, "true", "1", "", "  false ", "False", "no"])(
    "keeps the pipeline enabled when PIPELINE_ENABLED is %j",
    (value) => {
      // Only the literal "false" (Terraform's tostring(false)) disables: an unset variable is every
      // laptop and every deployment that predates it, and a typo must fail towards the visible state.
      expect(isAppEnabled("pipeline", { PIPELINE_ENABLED: value })).toBe(true);
    },
  );

  it("disables the pipeline on exactly false, by id or by definition", () => {
    expect(isAppEnabled("pipeline", { PIPELINE_ENABLED: "false" })).toBe(false);
    expect(isAppEnabled(appById("pipeline")!, { PIPELINE_ENABLED: "false" })).toBe(false);
  });
});

describe("accessGroupsRequired", () => {
  it("is only the literal true", () => {
    expect(accessGroupsRequired({ REQUIRE_ACCESS_GROUPS: "true" })).toBe(true);
    for (const value of [undefined, "", "TRUE", "1", "yes", " true"]) {
      expect(accessGroupsRequired({ REQUIRE_ACCESS_GROUPS: value }), String(value)).toBe(false);
    }
  });
});

describe("accessGroupFor / adminGroupFor", () => {
  it("return the trimmed group, by id or by definition", () => {
    const env = { RECON_ACCESS_GROUP: "  recon-users ", RECON_ADMIN_GROUP: "recon-admin  " };
    expect(accessGroupFor("recon", env)).toBe("recon-users");
    expect(adminGroupFor("recon", env)).toBe("recon-admin");
    expect(adminGroupFor(appById("recon")!, env)).toBe("recon-admin");
  });

  it("return an empty string for an unset or blank variable", () => {
    expect(accessGroupFor("pipeline", {})).toBe("");
    expect(adminGroupFor("pipeline", { PIPELINE_ADMIN_GROUP: "   " })).toBe("");
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

describe("resolveAppAccess for a disabled app", () => {
  const DISABLED = { ...RESTRICTED, PIPELINE_ENABLED: "false" };

  it("is closed to everyone, including the app's own admins", () => {
    // Nothing is deployed to administer, and `admin: true` would make the rail show a chip for an app it
    // must not list.
    expect(resolveAppAccess(["deal-desk", "deal-desk-admins"], DISABLED).pipeline).toEqual({
      access: false,
      admin: false,
    });
  });

  it("is closed even when no group is configured at all", () => {
    // The recon-only upgrade path: every group variable blank, PIPELINE_ENABLED=false from Terraform.
    expect(resolveAppAccess(["anything"], { PIPELINE_ENABLED: "false" })).toEqual({
      recon: { access: true, admin: false },
      pipeline: { access: false, admin: false },
    });
  });

  it("does not affect the other app", () => {
    expect(resolveAppAccess(["recon-admin"], DISABLED).recon).toEqual({ access: true, admin: true });
  });
});

describe("resolveAppAccess under REQUIRE_ACCESS_GROUPS", () => {
  const CLOSED = { REQUIRE_ACCESS_GROUPS: "true", RECON_ADMIN_GROUP: "recon-admin" };

  it("denies an app whose access group is unset to a caller who is not its admin", () => {
    // The composed deployment: "every authenticated user" is two desks, and recon has write routes that
    // rely on the access group as their only gate.
    expect(resolveAppAccess(["deal-desk"], CLOSED).recon).toEqual({ access: false, admin: false });
    expect(resolveAppAccess([], CLOSED).recon).toEqual({ access: false, admin: false });
  });

  it("treats a blank access group as unset, so it is denied too", () => {
    expect(
      resolveAppAccess([""], { ...CLOSED, RECON_ACCESS_GROUP: "   " }).recon,
    ).toEqual({ access: false, admin: false });
  });

  it("still admits the app's admins: fail closed, not locked out", () => {
    expect(resolveAppAccess(["recon-admin"], CLOSED).recon).toEqual({ access: true, admin: true });
  });

  it("changes nothing for an app whose access group IS configured", () => {
    const env = { ...RESTRICTED, REQUIRE_ACCESS_GROUPS: "true" };
    expect(resolveAppAccess(["recon-users"], env).recon).toEqual({ access: true, admin: false });
    expect(resolveAppAccess(["deal-desk"], env).recon).toEqual({ access: false, admin: false });
  });

  it("is ignored unless the value is exactly true", () => {
    expect(resolveAppAccess([], { REQUIRE_ACCESS_GROUPS: "TRUE" }).recon.access).toBe(true);
    expect(resolveAppAccess([], { REQUIRE_ACCESS_GROUPS: "1" }).recon.access).toBe(true);
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

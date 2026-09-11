// @vitest-environment node
/**
 * The proxy's per-app decision, as a table.
 *
 * Pure function, injected environment: this is where the 403 wording is pinned, because the shell
 * and any support runbook quote it. The proxy test covers the same rule through a real request; this
 * one covers the corners cheaply.
 */
import { describe, expect, it } from "vitest";

import { accessDeniedMessage, appDisabledMessage, decideApiAccess } from "@/lib/auth/access";
import { appById } from "@/lib/auth/apps";

const RESTRICTED = {
  RECON_ACCESS_GROUP: "recon-users",
  RECON_ADMIN_GROUP: "recon-admin",
  PIPELINE_ACCESS_GROUP: "deal-desk",
};

const DENIED_RECON =
  "no access to Trade Reconciliation: membership of the recon-users group is required";
const DENIED_PIPELINE =
  "no access to Deal Pipeline: membership of the deal-desk group is required";
const DISABLED_PIPELINE = "Deal Pipeline is not enabled on this deployment";
const CLOSED_RECON =
  "no access to Trade Reconciliation: RECON_ACCESS_GROUP is not configured and " +
  "REQUIRE_ACCESS_GROUPS is true, so only members of its admin group may use it";

describe("decideApiAccess", () => {
  it("allows a path no app owns on authentication alone, however restricted the apps are", () => {
    // `/api/me` is how the shell learns which apps to show, so it must answer a caller who has none.
    expect(decideApiAccess("/api/me", [], RESTRICTED)).toEqual({ allowed: true });
  });

  it("allows an app whose access group is unset", () => {
    expect(decideApiAccess("/api/pipeline/deals", [], { RECON_ACCESS_GROUP: "recon-users" })).toEqual({
      allowed: true,
    });
  });

  it("allows a member of the access group", () => {
    expect(decideApiAccess("/api/recon/cases", ["recon-users"], RESTRICTED)).toEqual({
      allowed: true,
    });
  });

  it("allows an admin who is not in the access group", () => {
    expect(decideApiAccess("/api/recon/cases", ["recon-admin"], RESTRICTED)).toEqual({
      allowed: true,
    });
  });

  it("denies a caller outside the group with the exact 403 wording", () => {
    expect(decideApiAccess("/api/recon/cases/1", ["deal-desk"], RESTRICTED)).toEqual({
      allowed: false,
      status: 403,
      message: DENIED_RECON,
    });
  });

  it("names each app's own label and group", () => {
    expect(decideApiAccess("/api/pipeline/deals", ["recon-users"], RESTRICTED)).toEqual({
      allowed: false,
      status: 403,
      message: DENIED_PIPELINE,
    });
  });

  it("guards the bare prefix as well as nested paths", () => {
    expect(decideApiAccess("/api/recon", [], RESTRICTED).allowed).toBe(false);
  });

  describe("disabled app", () => {
    const RECON_ONLY = { PIPELINE_ENABLED: "false", PIPELINE_ADMIN_GROUP: "deal-desk-admins" };

    it("403s every path under the prefix, naming the app rather than a group", () => {
      // A recon-only console: no group would help, and the pipeline's routes must never run against
      // whatever resources the shared container does have.
      for (const path of ["/api/pipeline", "/api/pipeline/deals", "/api/pipeline/skills/x"]) {
        expect(decideApiAccess(path, [], RECON_ONLY), path).toEqual({
          allowed: false,
          status: 403,
          message: DISABLED_PIPELINE,
        });
      }
    });

    it("403s the app's own admin too", () => {
      expect(decideApiAccess("/api/pipeline/config", ["deal-desk-admins"], RECON_ONLY).allowed).toBe(
        false,
      );
    });

    it("leaves the other app and /api/me untouched", () => {
      expect(decideApiAccess("/api/recon/cases", [], RECON_ONLY)).toEqual({ allowed: true });
      expect(decideApiAccess("/api/me", [], RECON_ONLY)).toEqual({ allowed: true });
    });
  });

  describe("REQUIRE_ACCESS_GROUPS", () => {
    const CLOSED = { REQUIRE_ACCESS_GROUPS: "true", RECON_ADMIN_GROUP: "recon-admin" };

    it("403s an app with no access group, and says which variable to set", () => {
      expect(decideApiAccess("/api/recon/cases", ["deal-desk"], CLOSED)).toEqual({
        allowed: false,
        status: 403,
        message: CLOSED_RECON,
      });
    });

    it("does not lock out the admin group", () => {
      expect(decideApiAccess("/api/recon/cases", ["recon-admin"], CLOSED)).toEqual({ allowed: true });
    });

    it("still admits /api/me for a caller who may use nothing", () => {
      expect(decideApiAccess("/api/me", [], CLOSED)).toEqual({ allowed: true });
    });
  });
});

describe("appDisabledMessage", () => {
  it("names the app", () => {
    expect(appDisabledMessage(appById("pipeline")!)).toBe(DISABLED_PIPELINE);
  });
});

describe("accessDeniedMessage", () => {
  it("trims the configured group name so the wording matches what the operator typed", () => {
    expect(accessDeniedMessage(appById("recon")!, { RECON_ACCESS_GROUP: "  recon-users " })).toBe(
      DENIED_RECON,
    );
  });

  it("names the switch and the variable instead of a blank group when none is configured", () => {
    // Only reachable under REQUIRE_ACCESS_GROUPS; "membership of the  group" would send the operator
    // hunting for a group that does not exist.
    expect(accessDeniedMessage(appById("recon")!, { RECON_ACCESS_GROUP: "  " })).toBe(CLOSED_RECON);
  });
});

// @vitest-environment node
/**
 * The proxy's per-app decision, as a table.
 *
 * Pure function, injected environment: this is where the 403 wording is pinned, because the shell
 * and any support runbook quote it. The proxy test covers the same rule through a real request; this
 * one covers the corners cheaply.
 */
import { describe, expect, it } from "vitest";

import { accessDeniedMessage, decideApiAccess } from "@/lib/auth/access";
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
});

describe("accessDeniedMessage", () => {
  it("trims the configured group name so the wording matches what the operator typed", () => {
    expect(accessDeniedMessage(appById("recon")!, { RECON_ACCESS_GROUP: "  recon-users " })).toBe(
      DENIED_RECON,
    );
  });
});

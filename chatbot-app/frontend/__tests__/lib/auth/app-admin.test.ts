// @vitest-environment node
/**
 * The role gate on app writes, for both apps.
 *
 * Two properties, and the first one is the whole reason this file exists. Approving a deal invokes
 * the OMS upload, editing a skill changes every future parse, and moving recon's auto-resolve
 * threshold decides which breaks skip a human entirely, so the assertions are about refusal: a
 * caller with a valid token and no admin group must be refused, and a deployment that has lost the
 * app's admin-group variable must refuse everyone rather than admit everyone.
 *
 * The second is that the refusal happens in the ROUTE, not in the tab. A hidden button is a courtesy;
 * the routes answer regardless of what the browser chose to render, so they are what gets tested.
 *
 * Both apps run through one table because the gate is one function parameterised by app. What
 * differs per app is the variable named and the tail of the "not configured" message, which each
 * app's routes have always worded their own way and must keep wording that way — so those two strings
 * are pinned verbatim. The recon-named entry points (`reconAdmin.ts`) keep their own test in
 * `api/reconAdminGuard.test.ts`.
 *
 * Node environment, not jsdom: the gate imports `api-auth`, which pulls in jose, and under jsdom
 * jose's `instanceof Uint8Array` check fails across realms before any assertion runs.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppId } from "@/lib/auth/apps";

import {
  clearAuthEnv,
  restoreAuthEnv,
  setAuthEnv,
  snapshotAuthEnv,
} from "./testEnv";

const authorizeRequest = vi.fn();
vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));

const { isAppAdmin, requireAppActor, requireAppAdmin } =
  await import("@/lib/auth/app-admin");

interface Case {
  app: AppId;
  variable: string;
  group: string;
  /** The whole "not configured" 403, in the app's own words. */
  unconfigured: string;
  path: string;
}

const CASES: Case[] = [
  {
    app: "recon",
    variable: "RECON_ADMIN_GROUP",
    group: "recon-admin",
    unconfigured:
      "RECON_ADMIN_GROUP is not configured, so no caller can change configuration",
    path: "/api/recon/config",
  },
  {
    app: "pipeline",
    variable: "PIPELINE_ADMIN_GROUP",
    group: "deal-desk-admins",
    unconfigured:
      "PIPELINE_ADMIN_GROUP is not configured, so no caller can change the pipeline",
    path: "/api/pipeline/deals/dl_1/approve",
  },
];

function req(path: string): Request {
  return new Request(`https://app.example${path}`, { method: "POST" });
}

function signedIn(subject: string, groups: string[]): void {
  authorizeRequest.mockResolvedValue({
    ok: true,
    mode: "okta",
    subject,
    groups,
  });
}

async function refusal(
  got: unknown,
): Promise<{ status: number; error: string }> {
  if (typeof got !== "object" || got === null || !("error" in got))
    throw new Error("expected a refusal");
  const response = (got as { error: Response }).error;
  return {
    status: response.status,
    error: ((await response.json()) as { error: string }).error,
  };
}

const saved = snapshotAuthEnv();
beforeEach(() => {
  authorizeRequest.mockReset();
  clearAuthEnv();
});
afterAll(() => restoreAuthEnv(saved));

describe.each(CASES)("isAppAdmin($app)", ({ app, variable, group }) => {
  it("admits a member of the configured group", () => {
    expect(isAppAdmin(app, ["x", group], { [variable]: group })).toBe(true);
  });

  it("refuses everyone when no group is configured", () => {
    // The alternative reading — "unset means unrestricted" — would silently reopen the hole this
    // closes, and it would do so on exactly the deploy that dropped the variable by mistake.
    expect(isAppAdmin(app, [group], {})).toBe(false);
  });

  it("matches the group name exactly", () => {
    // No prefix or case-insensitive matching: "<group>-readonly" is a different group and must not
    // inherit write access from a substring.
    expect(
      isAppAdmin(app, [group.toUpperCase(), `${group}-readonly`], {
        [variable]: group,
      }),
    ).toBe(false);
  });

  it("trims the configured name, so it agrees with what /api/me reports", () => {
    // `resolveAppAccess` trims; if this did not, a padded tfvars value would show an admin chip in the
    // rail while every write route answered 403.
    expect(isAppAdmin(app, [group], { [variable]: `  ${group}  ` })).toBe(true);
  });

  it("reads a blank variable as unset rather than as a group named by whitespace", () => {
    expect(isAppAdmin(app, ["  ", ""], { [variable]: "  " })).toBe(false);
  });

  it("reads the process environment when none is given", () => {
    setAuthEnv({ [variable]: group });
    expect(isAppAdmin(app, [group])).toBe(true);
  });
});

it("reads THIS app's variable, never the other app's", () => {
  // One caller, in the pipeline's admin group only: an admin there, nobody on recon.
  const env = {
    RECON_ADMIN_GROUP: "recon-admin",
    PIPELINE_ADMIN_GROUP: "deal-desk-admins",
  };
  expect(isAppAdmin("pipeline", ["deal-desk-admins"], env)).toBe(true);
  expect(isAppAdmin("recon", ["deal-desk-admins"], env)).toBe(false);
});

describe.each(CASES)(
  "requireAppActor($app)",
  ({ app, variable, group, path }) => {
    // The chat route's shape: every verified caller is admitted, and the flag says which tools the
    // session may be offered. The 403 is not this function's job — a non-admin can still chat.
    beforeEach(() => setAuthEnv({ [variable]: group }));

    it("admits an admin with isAdmin true", async () => {
      signedIn("sub-reviewer-1", [group]);
      expect(await requireAppActor(app, req(path))).toEqual({
        actor: "sub-reviewer-1",
        isAdmin: true,
      });
    });

    it("admits a non-admin with isAdmin false rather than refusing", async () => {
      signedIn("sub-analyst-2", ["desk-readers"]);
      expect(await requireAppActor(app, req(path))).toEqual({
        actor: "sub-analyst-2",
        isAdmin: false,
      });
    });

    it("reports isAdmin false for everyone when the admin group is unset", async () => {
      clearAuthEnv();
      signedIn("sub-reviewer-1", [group]);
      expect(await requireAppActor(app, req(path))).toEqual({
        actor: "sub-reviewer-1",
        isAdmin: false,
      });
    });

    it("passes a token failure through with its own status", async () => {
      authorizeRequest.mockResolvedValue({
        ok: false,
        status: 401,
        message: "token rejected",
      });
      expect(await refusal(await requireAppActor(app, req(path)))).toEqual({
        status: 401,
        error: "token rejected",
      });
    });
  },
);

describe.each(CASES)(
  "requireAppAdmin($app)",
  ({ app, variable, group, unconfigured, path }) => {
    beforeEach(() => setAuthEnv({ [variable]: group }));

    it("names the verified subject for an admin", async () => {
      signedIn("sub-reviewer-1", [group]);
      expect(await requireAppAdmin(app, req(path))).toEqual({
        actor: "sub-reviewer-1",
      });
    });

    it("403s an authenticated caller who is not in the group, naming the group and the caller", async () => {
      signedIn("sub-analyst-2", ["desk-readers"]);
      // 403 rather than 401: the token is fine and re-authenticating will not help. The message names
      // the group, so an operator can act on it without reading the source. Pinned verbatim: it is the
      // text both apps' routes have always answered with.
      expect(await refusal(await requireAppAdmin(app, req(path)))).toEqual({
        status: 403,
        error: `this endpoint requires membership of the "${group}" group; sub-analyst-2 is not a member`,
      });
    });

    it("names the trimmed group in the 403, not the padded value", async () => {
      setAuthEnv({ [variable]: `${group} ` });
      signedIn("sub-analyst-2", ["desk-readers"]);
      const { error } = await refusal(await requireAppAdmin(app, req(path)));
      expect(error).toContain(`"${group}" group`);
      expect(error).not.toContain(`"${group} "`);
    });

    it("403s everyone when the admin group is blank, naming the variable in the app's own words", async () => {
      setAuthEnv({ [variable]: "  " });
      signedIn("sub-reviewer-1", [group, "  "]);
      expect(await refusal(await requireAppAdmin(app, req(path)))).toEqual({
        status: 403,
        error: unconfigured,
      });
    });

    it("403s everyone when the admin group is unset, naming the variable", async () => {
      clearAuthEnv();
      signedIn("sub-reviewer-1", [group]);
      expect(await refusal(await requireAppAdmin(app, req(path)))).toEqual({
        status: 403,
        error: unconfigured,
      });
    });

    it("passes a token failure through with its own status", async () => {
      // A 503 from an unreachable identity provider must not be flattened into "you are not an admin":
      // one says sign in again or wait, the other says ask for access.
      authorizeRequest.mockResolvedValue({
        ok: false,
        status: 503,
        message: "could not verify token",
      });
      expect(
        (await refusal(await requireAppAdmin(app, req(path)))).status,
      ).toBe(503);
    });
  },
);

it("gates each app on its own group: a pipeline admin is admitted by the pipeline and refused by recon", async () => {
  setAuthEnv({
    RECON_ADMIN_GROUP: "recon-admin",
    PIPELINE_ADMIN_GROUP: "deal-desk-admins",
  });
  signedIn("sub-reviewer-1", ["deal-desk-admins"]);
  expect(
    await requireAppAdmin("pipeline", req("/api/pipeline/skills")),
  ).toEqual({ actor: "sub-reviewer-1" });
  expect(
    (await refusal(await requireAppAdmin("recon", req("/api/recon/config"))))
      .status,
  ).toBe(403);
});

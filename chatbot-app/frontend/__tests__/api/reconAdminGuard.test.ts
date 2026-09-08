// @vitest-environment node
/**
 * The role gate on configuration changes.
 *
 * Two properties, and the first one is the whole reason this file exists. Before the gate, any
 * authenticated user could move the auto-resolve threshold — the number that decides which breaks skip a
 * human entirely — and nothing about the UI hinted that this was privileged. So the assertions are about
 * refusal: a caller with a valid token and no admin group must be refused, and a deployment that has
 * lost `RECON_ADMIN_GROUP` must refuse everyone rather than admit everyone.
 *
 * The second is that the refusal happens in the ROUTE, not in the tab. A hidden tab is a courtesy; the
 * routes answer regardless of what the browser chose to render, so they are what gets tested.
 *
 * Node environment, not jsdom: `reconAdmin` imports `api-auth`, which pulls in jose, and under jsdom
 * jose's `instanceof Uint8Array` check fails across realms before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authorizeRequest = vi.fn();
vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));

const { isReconAdmin, requireReconAdmin } = await import("@/lib/reconAdmin");

function req(): Request {
  return new Request("https://app.example/api/recon/config", {
    method: "PUT",
  });
}

const savedGroup = process.env.RECON_ADMIN_GROUP;

beforeEach(() => {
  authorizeRequest.mockReset();
  process.env.RECON_ADMIN_GROUP = "recon-admin";
});

afterEach(() => {
  if (savedGroup === undefined) delete process.env.RECON_ADMIN_GROUP;
  else process.env.RECON_ADMIN_GROUP = savedGroup;
});

describe("isReconAdmin", () => {
  it("admits a member of the configured group", () => {
    expect(
      isReconAdmin(["x", "recon-admin"], { RECON_ADMIN_GROUP: "recon-admin" }),
    ).toBe(true);
  });

  it("refuses everyone when no group is configured", () => {
    // The alternative reading — "unset means unrestricted" — would silently reopen the hole this
    // closes, and it would do so on exactly the deploy that dropped the variable by mistake.
    expect(isReconAdmin(["recon-admin"], {})).toBe(false);
  });

  it("matches the group name exactly", () => {
    // No prefix or case-insensitive matching. "recon-administrators-readonly" is a different group and
    // must not inherit write access from a substring.
    expect(
      isReconAdmin(["Recon-Admin", "recon-admins"], {
        RECON_ADMIN_GROUP: "recon-admin",
      }),
    ).toBe(false);
  });
});

describe("requireReconAdmin", () => {
  it("names the verified subject for an admin", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "00uOPERATOR",
      groups: ["recon-admin"],
    });

    expect(await requireReconAdmin(req())).toEqual({ actor: "00uOPERATOR" });
  });

  it("403s an authenticated caller who is not in the group", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "00uANALYST",
      groups: ["recon-analyst"],
    });

    const got = await requireReconAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(403);
    const body = (await got.error.json()) as { error: string };
    // 403 rather than 401: the token is fine and re-authenticating will not help. The message names the
    // group, so an operator can act on it without reading the source to find out what they are missing.
    expect(body.error).toContain("recon-admin");
    expect(body.error).toContain("00uANALYST");
  });

  it("403s everyone when RECON_ADMIN_GROUP is unset, naming the variable", async () => {
    delete process.env.RECON_ADMIN_GROUP;
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "00uOPERATOR",
      groups: ["recon-admin"],
    });

    const got = await requireReconAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(403);
    expect(((await got.error.json()) as { error: string }).error).toContain(
      "RECON_ADMIN_GROUP",
    );
  });

  it("passes a token failure through with its own status", async () => {
    // A 503 from an unreachable identity provider must not be flattened into "you are not an admin":
    // one says sign in again or wait, the other says ask for access.
    authorizeRequest.mockResolvedValue({
      ok: false,
      status: 503,
      message: "could not verify token",
    });

    const got = await requireReconAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(503);
  });
});

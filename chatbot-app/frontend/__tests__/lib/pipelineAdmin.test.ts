// @vitest-environment node
/**
 * The role gate on pipeline writes.
 *
 * Two properties, and the first one is the whole reason this file exists. Approving a deal invokes
 * the OMS upload and editing a skill changes every future parse, so the assertions are about
 * refusal: a caller with a valid token and no admin group must be refused, and a deployment that has
 * lost `PIPELINE_ADMIN_GROUP` must refuse everyone rather than admit everyone.
 *
 * The second is that the refusal happens in the ROUTE, not in the tab. A hidden button is a courtesy;
 * the routes answer regardless of what the browser chose to render, so they are what gets tested.
 *
 * Node environment, not jsdom: `pipelineAdmin` imports `api-auth`, which pulls in jose, and under
 * jsdom jose's `instanceof Uint8Array` check fails across realms before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authorizeRequest = vi.fn();
vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));

const { isPipelineAdmin, requirePipelineActor, requirePipelineAdmin } = await import(
  "@/lib/pipelineAdmin"
);

function req(): Request {
  return new Request("https://app.example/api/pipeline/deals/dl_1/approve", {
    method: "POST",
  });
}

const savedGroup = process.env.PIPELINE_ADMIN_GROUP;

beforeEach(() => {
  authorizeRequest.mockReset();
  process.env.PIPELINE_ADMIN_GROUP = "deal-desk-admins";
});

afterEach(() => {
  if (savedGroup === undefined) delete process.env.PIPELINE_ADMIN_GROUP;
  else process.env.PIPELINE_ADMIN_GROUP = savedGroup;
});

describe("isPipelineAdmin", () => {
  it("admits a member of the configured group", () => {
    expect(
      isPipelineAdmin(["x", "deal-desk-admins"], {
        PIPELINE_ADMIN_GROUP: "deal-desk-admins",
      }),
    ).toBe(true);
  });

  it("refuses everyone when no group is configured", () => {
    // The alternative reading — "unset means unrestricted" — would silently reopen the hole this
    // closes, and it would do so on exactly the deploy that dropped the variable by mistake.
    expect(isPipelineAdmin(["deal-desk-admins"], {})).toBe(false);
  });

  it("matches the group name exactly", () => {
    // No prefix or case-insensitive matching: "deal-desk-admins-readonly" is a different group and
    // must not inherit write access from a substring.
    expect(
      isPipelineAdmin(["Deal-Desk-Admins", "deal-desk-admins-readonly"], {
        PIPELINE_ADMIN_GROUP: "deal-desk-admins",
      }),
    ).toBe(false);
  });
});

describe("requirePipelineActor", () => {
  // The chat route's shape: every verified caller is admitted, and the flag says which tools the
  // session may be offered. The 403 is not this function's job — a non-admin can still chat.
  it("admits an admin with isAdmin true", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "sub-reviewer-1",
      groups: ["deal-desk-admins"],
    });
    expect(await requirePipelineActor(req())).toEqual({ actor: "sub-reviewer-1", isAdmin: true });
  });

  it("admits a non-admin with isAdmin false rather than refusing", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "sub-analyst-2",
      groups: ["deal-desk-readers"],
    });
    expect(await requirePipelineActor(req())).toEqual({ actor: "sub-analyst-2", isAdmin: false });
  });

  it("reports isAdmin false for everyone when PIPELINE_ADMIN_GROUP is unset", async () => {
    delete process.env.PIPELINE_ADMIN_GROUP;
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "okta",
      subject: "sub-reviewer-1",
      groups: ["deal-desk-admins"],
    });
    expect(await requirePipelineActor(req())).toEqual({ actor: "sub-reviewer-1", isAdmin: false });
  });

  it("passes a token failure through with its own status", async () => {
    authorizeRequest.mockResolvedValue({ ok: false, status: 401, message: "token rejected" });
    const got = await requirePipelineActor(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(401);
    expect(((await got.error.json()) as { error: string }).error).toBe("token rejected");
  });
});

describe("requirePipelineAdmin", () => {
  it("names the verified subject for an admin", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "entra",
      subject: "sub-reviewer-1",
      groups: ["deal-desk-admins"],
    });
    expect(await requirePipelineAdmin(req())).toEqual({ actor: "sub-reviewer-1" });
  });

  it("403s an authenticated caller who is not in the group", async () => {
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "entra",
      subject: "sub-analyst-2",
      groups: ["deal-desk-readers"],
    });
    const got = await requirePipelineAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(403);
    const body = (await got.error.json()) as { error: string };
    // 403 rather than 401: the token is fine and re-authenticating will not help. The message names
    // the group, so an operator can act on it without reading the source.
    expect(body.error).toContain("deal-desk-admins");
    expect(body.error).toContain("sub-analyst-2");
  });

  it("403s everyone when PIPELINE_ADMIN_GROUP is unset, naming the variable", async () => {
    delete process.env.PIPELINE_ADMIN_GROUP;
    authorizeRequest.mockResolvedValue({
      ok: true,
      mode: "entra",
      subject: "sub-reviewer-1",
      groups: ["deal-desk-admins"],
    });
    const got = await requirePipelineAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(403);
    expect(((await got.error.json()) as { error: string }).error).toContain(
      "PIPELINE_ADMIN_GROUP",
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
    const got = await requirePipelineAdmin(req());
    if (!("error" in got)) throw new Error("expected a refusal");
    expect(got.error.status).toBe(503);
  });
});

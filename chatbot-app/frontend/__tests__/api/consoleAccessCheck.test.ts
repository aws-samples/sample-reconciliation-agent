// @vitest-environment node
/**
 * `/api/console/access-check`: "what would a user in these groups see?"
 *
 * The property that matters is that the answer is computed by the SAME functions, against the SAME
 * overlaid environment, as the proxy and `/api/me`: a stored access group must change the prediction
 * exactly as it changes the gate. Real verifier and registry; only Parameter Store is faked.
 *
 * Node environment: `api-auth` pulls in jose, whose `instanceof Uint8Array` check fails across realms
 * under jsdom.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessCheckResult } from "@/lib/console/types";

import { ssmModule } from "../helpers/awsMocks";
import { AUTH_ENV_NAMES, scopedEnv } from "../helpers/env";
import { createFakeSsm, type FakeSsm, type FakeSsmCommand } from "../helpers/fakeSsm";

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ssmModule(ssmSend));

const { GET } = await import("@/app/api/console/access-check/route");
const { invalidate } = await import("@/lib/console/settings");
const { parseGroupList } = await import("@/lib/console/validation");

const PREFIX = "/recon-test/console";
const ADMIN = { ALLOW_ANONYMOUS_API: "true", CONSOLE_ADMIN_GROUP: "console-admins" };

let fake: FakeSsm;
const authEnv = scopedEnv(AUTH_ENV_NAMES);

beforeEach(() => {
  authEnv.clear();
  fake = createFakeSsm();
  ssmSend.mockReset();
  ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
  invalidate();
});
afterAll(() => authEnv.restore());

function get(query = "", headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request(`https://app.example/api/console/access-check${query}`, { headers }));
}

describe("parseGroupList", () => {
  it("splits on commas, trims, drops blanks and de-duplicates", () => {
    expect(parseGroupList("a, b ,,a,c")).toEqual(["a", "b", "c"]);
  });

  it("reads an absent or empty parameter as no groups", () => {
    expect(parseGroupList(null)).toEqual([]);
    expect(parseGroupList("")).toEqual([]);
    expect(parseGroupList(" , ")).toEqual([]);
  });
});

describe("GET /api/console/access-check", () => {
  it("401s without a token", async () => {
    authEnv.set({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
    });
    expect((await get("?groups=x")).status).toBe(401);
  });

  it("403s a non-admin, naming CONSOLE_ADMIN_GROUP", async () => {
    authEnv.set({ ...ADMIN, ANONYMOUS_GROUPS: "recon-users" });
    const res = await get("?groups=x");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("CONSOLE_ADMIN_GROUP");
  });

  it("predicts per-app access from the environment, with no-store", async () => {
    authEnv.set({
      ...ADMIN,
      RECON_ACCESS_GROUP: "recon-users",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
    });
    const res = await get("?groups=deal-desk,%20recon-admin,deal-desk");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()) as AccessCheckResult).toEqual({
      groups: ["deal-desk", "recon-admin"],
      apps: {
        recon: { access: true, admin: true },
        pipeline: { access: true, admin: false },
      },
      consoleAdmin: false,
    });
  });

  it("answers for a user in no groups", async () => {
    authEnv.set({ ...ADMIN, RECON_ACCESS_GROUP: "recon-users" });
    const body = (await (await get()).json()) as AccessCheckResult;
    expect(body.groups).toEqual([]);
    expect(body.apps.recon).toEqual({ access: false, admin: false });
    // The pipeline has no access group here, so it is open.
    expect(body.apps.pipeline).toEqual({ access: true, admin: false });
  });

  it("uses the stored overlay: a stored access group denies what the environment would admit", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "access/recon/access-group": "recon-users", "apps/pipeline/enabled": "false" });
    const body = (await (await get("?groups=deal-desk")).json()) as AccessCheckResult;
    expect(body.apps).toEqual({
      recon: { access: false, admin: false },
      pipeline: { access: false, admin: false },
    });
    const admitted = (await (await get("?groups=recon-users")).json()) as AccessCheckResult;
    expect(admitted.apps.recon).toEqual({ access: true, admin: false });
  });

  it("reports console-admin status from the environment only", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    // A stored parameter spelled like the variable must not count.
    fake.store.set(`${PREFIX}/access/CONSOLE_ADMIN_GROUP`, "deal-desk");
    expect(((await (await get("?groups=console-admins")).json()) as AccessCheckResult).consoleAdmin).toBe(true);
    expect(((await (await get("?groups=deal-desk")).json()) as AccessCheckResult).consoleAdmin).toBe(false);
  });
});

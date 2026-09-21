// @vitest-environment node
/**
 * `/api/console/settings`: the console admin's view and edit of the stored layer.
 *
 * Real verifier and registry, driven by `process.env`, with only Parameter Store faked: the contract
 * under test is the wiring from the anonymous group list through `CONSOLE_ADMIN_GROUP` to the 403,
 * and from a PUT body through validation to the parameters written. Anonymous mode holds every
 * configured group, including the console admin group, so it stands in for an admin's token;
 * `ANONYMOUS_GROUPS=nobody` stands in for an authenticated non-admin.
 *
 * Node environment: `api-auth` pulls in jose, whose `instanceof Uint8Array` check fails across realms
 * under jsdom.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConsoleSettings } from "@/lib/console/types";

import { ssmModule } from "../helpers/awsMocks";
import { AUTH_ENV_NAMES, scopedEnv } from "../helpers/env";
import { createFakeSsm, type FakeSsm, type FakeSsmCommand } from "../helpers/fakeSsm";
import { jsonRequest } from "../helpers/http";

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ssmModule(ssmSend));

const { GET, PUT } = await import("@/app/api/console/settings/route");
const { invalidate } = await import("@/lib/console/settings");

const PREFIX = "/recon-test/console";
const ADMIN = { ALLOW_ANONYMOUS_API: "true", CONSOLE_ADMIN_GROUP: "console-admins" };
const NON_ADMIN = { ...ADMIN, ANONYMOUS_GROUPS: "recon-admins" };

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

function get(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request("https://app.example/api/console/settings", { headers }));
}

function put(body: unknown, raw = false): Promise<Response> {
  return PUT(jsonRequest("PUT", "https://app.example/api/console/settings", body, { raw }));
}

async function error(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}


/** SSM commands that would change state. Reads may happen during authorization (the anonymous identity
 *  is derived from the overlaid environment), so "touched nothing" means "wrote nothing". */
function ssmWrites(): unknown[] {
  return ssmSend.mock.calls.filter(([cmd]) => {
    const kind = (cmd as { __cmd?: string }).__cmd;
    return kind === "Put" || kind === "Delete";
  });
}

describe("GET /api/console/settings authentication and authorization", () => {
  it("401s without a token", async () => {
    authEnv.set({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
      CONSOLE_ADMIN_GROUP: "console-admins",
    });
    const res = await get();
    expect(res.status).toBe(401);
    expect(await error(res)).toContain("Authorization");
  });

  it("503s when authorization is misconfigured", async () => {
    expect((await get()).status).toBe(503);
  });

  it("403s an authenticated non-admin, naming the group and CONSOLE_ADMIN_GROUP", async () => {
    authEnv.set(NON_ADMIN);
    const res = await get();
    expect(res.status).toBe(403);
    const message = await error(res);
    expect(message).toContain('"console-admins"');
    expect(message).toContain("CONSOLE_ADMIN_GROUP");
    expect(message).toContain("anonymous");
    expect(ssmWrites()).toHaveLength(0);
  });

  it("403s everyone when CONSOLE_ADMIN_GROUP is unset, naming the variable", async () => {
    // Fail closed: anonymous mode holds every CONFIGURED group, and this one is not configured.
    authEnv.set({ ALLOW_ANONYMOUS_API: "true" });
    const res = await get();
    expect(res.status).toBe(403);
    expect(await error(res)).toContain("CONSOLE_ADMIN_GROUP is not configured");
  });

  it("does not let a stored parameter make someone a console admin", async () => {
    // The overlay never carries CONSOLE_ADMIN_GROUP; even a parameter named like it changes nothing.
    authEnv.set({ ...NON_ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.store.set(`${PREFIX}/access/CONSOLE_ADMIN_GROUP`, "recon-admins");
    expect((await get()).status).toBe(403);
  });
});

describe("GET /api/console/settings for an admin", () => {
  it("answers on a deployment without the stored layer, marked unconfigured, with no-store", async () => {
    authEnv.set({ ...ADMIN, RECON_ACCESS_GROUP: "recon-users" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ConsoleSettings;
    expect(body.configured).toBe(false);
    expect(body.prefix).toBeNull();
    expect(body.access.recon.accessGroup).toEqual({ value: "recon-users", source: "env", envName: "RECON_ACCESS_GROUP" });
    expect(body.envOnly).toEqual({ requireAccessGroups: false, anonymousMode: true, consoleAdminGroup: "console-admins" });
    expect(ssmWrites()).toHaveLength(0);
  });

  it("reports stored values with their source when configured", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX, RECON_ACCESS_GROUP: "env-users" });
    fake.seed(PREFIX, {
      "access/recon/access-group": "stored-users",
      "defaults/organization-label": "Northwind Capital",
      "meta/updated": JSON.stringify({ at: "2026-09-11T10:00:00.000Z", by: "00uADMIN" }),
    });
    const body = (await (await get()).json()) as ConsoleSettings;
    expect(body.configured).toBe(true);
    expect(body.prefix).toBe(PREFIX);
    expect(body.access.recon.accessGroup).toEqual({ value: "stored-users", source: "stored", envName: "RECON_ACCESS_GROUP" });
    expect(body.defaults.organizationLabel.value).toBe("Northwind Capital");
    expect(body.updatedBy).toBe("00uADMIN");
  });

  it("500s with the reason when Parameter Store cannot be read", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockRejectedValue(new Error("AccessDeniedException: ssm:GetParametersByPath"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await error(res)).toContain("ssm:GetParametersByPath");
  });
});

describe("PUT /api/console/settings", () => {
  it("403s a non-admin before reading the body or touching SSM", async () => {
    authEnv.set({ ...NON_ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    const res = await put({ defaults: { organizationLabel: "x" } });
    expect(res.status).toBe(403);
    expect(await error(res)).toContain("CONSOLE_ADMIN_GROUP");
    expect(ssmWrites()).toHaveLength(0);
  });

  it("409s when the stored layer is not configured", async () => {
    authEnv.set(ADMIN);
    const res = await put({ defaults: { organizationLabel: "x" } });
    expect(res.status).toBe(409);
    expect(await error(res)).toContain("CONSOLE_SETTINGS_PREFIX");
    expect(ssmWrites()).toHaveLength(0);
  });

  it("400s a body that is not JSON", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    const res = await put("{not json", true);
    expect(res.status).toBe(400);
    expect(await error(res)).toContain("JSON");
  });

  it("400s an invalid field with the validator's message and writes nothing", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    const res = await put({ access: { recon: { accessGroup: "ok" }, pipeline: { adminGroup: "bad;name" } } });
    expect(res.status).toBe(400);
    expect(await error(res)).toContain("access.pipeline.adminGroup");
    expect(ssmWrites()).toHaveLength(0);
  });

  it("400s an empty update", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    expect((await put({})).status).toBe(400);
  });

  it("writes the fields, records the actor, and returns the refreshed settings", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX, RECON_ADMIN_GROUP: "env-admin" });
    fake.seed(PREFIX, { "access/recon/admin-group": "old-admin" });
    const res = await put({
      access: { recon: { accessGroup: "recon-users", adminGroup: "" } },
      apps: { pipeline: { enabled: false } },
      defaults: { organizationLabel: "Northwind Capital" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as ConsoleSettings;
    expect(body.configured).toBe(true);
    expect(body.access.recon.accessGroup).toEqual({ value: "recon-users", source: "stored", envName: "RECON_ACCESS_GROUP" });
    // Cleared: falls back to the environment.
    expect(body.access.recon.adminGroup).toEqual({ value: "env-admin", source: "env", envName: "RECON_ADMIN_GROUP" });
    expect(body.apps.pipeline!.enabled).toEqual({ value: "false", source: "stored", envName: "PIPELINE_ENABLED" });
    expect(body.defaults.organizationLabel.value).toBe("Northwind Capital");
    expect(body.updatedBy).toBe("anonymous");
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(fake.store.get(`${PREFIX}/access/recon/access-group`)).toBe("recon-users");
    expect(fake.store.has(`${PREFIX}/access/recon/admin-group`)).toBe(false);
    expect(fake.store.get(`${PREFIX}/apps/pipeline/enabled`)).toBe("false");
    expect(JSON.parse(fake.store.get(`${PREFIX}/meta/updated`)!).by).toBe("anonymous");
  });

  it("500s with the reason when a write fails", async () => {
    authEnv.set({ ...ADMIN, CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockImplementation(async (cmd: FakeSsmCommand) => {
      if (cmd.__cmd === "Put") throw new Error("AccessDeniedException: ssm:PutParameter");
      return fake.send(cmd);
    });
    const res = await put({ defaults: { organizationLabel: "x" } });
    expect(res.status).toBe(500);
    expect(await error(res)).toContain("ssm:PutParameter");
  });
});

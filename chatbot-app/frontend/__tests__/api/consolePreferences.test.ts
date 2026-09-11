// @vitest-environment node
/**
 * `/api/console/preferences`: a user's own row, and only their own.
 *
 * The subject comes from the verified token, never from the request, so the isolation property is
 * structural: there is no parameter a caller could set to read another user's row. The other
 * property is the fallback: on a deployment without the stored layer GET answers `{}` and PUT
 * answers 409, which is what tells the shell to keep using the browser.
 *
 * Node environment: `api-auth` pulls in jose, whose `instanceof Uint8Array` check fails across realms
 * under jsdom.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthEnv, restoreAuthEnv, setAuthEnv, snapshotAuthEnv } from "../lib/auth/testEnv";
import { createFakeSsm, ssmCommandMocks, type FakeSsm, type FakeSsmCommand } from "../lib/console/fakeSsm";

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  ...ssmCommandMocks((impl) => vi.fn().mockImplementation(impl as never) as never),
}));

const { GET, PUT } = await import("@/app/api/console/preferences/route");
const { invalidate, preferencesParameterName } = await import("@/lib/console/settings");

const PREFIX = "/recon-test/console";
// Any authenticated user; no admin group needed.
const USER = { ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "deal-desk" };

let fake: FakeSsm;
const saved = snapshotAuthEnv();

beforeEach(() => {
  clearAuthEnv();
  fake = createFakeSsm();
  ssmSend.mockReset();
  ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
  invalidate();
});
afterAll(() => restoreAuthEnv(saved));

function get(headers: Record<string, string> = {}): Promise<Response> {
  return GET(new Request("https://app.example/api/console/preferences", { headers }));
}

function put(body: unknown, raw = false): Promise<Response> {
  return PUT(
    new Request("https://app.example/api/console/preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  );
}


/** SSM commands that would change state. Reads may happen during authorization (the anonymous identity
 *  is derived from the overlaid environment), so "touched nothing" means "wrote nothing". */
function ssmWrites(): unknown[] {
  return ssmSend.mock.calls.filter(([cmd]) => {
    const kind = (cmd as { __cmd?: string }).__cmd;
    return kind === "Put" || kind === "Delete";
  });
}

describe("GET /api/console/preferences", () => {
  it("401s without a token", async () => {
    setAuthEnv({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
    });
    expect((await get()).status).toBe(401);
  });

  it("answers {} without touching SSM when the layer is not configured", async () => {
    setAuthEnv(USER);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({});
    expect(ssmWrites()).toHaveLength(0);
  });

  it("answers {} for a user with no row", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    expect(await (await get()).json()).toEqual({});
  });

  it("returns the caller's own row and nobody else's", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    // The anonymous subject is literally "anonymous"; another user's row sits beside it.
    fake.store.set(preferencesParameterName("anonymous", PREFIX), JSON.stringify({ theme: "dark" }));
    fake.store.set(preferencesParameterName("00uSOMEONE", PREFIX), JSON.stringify({ theme: "light", railCollapsed: true }));
    expect(await (await get()).json()).toEqual({ theme: "dark" });
  });

  it("500s when Parameter Store fails for a reason other than not-found", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    expect((await get()).status).toBe(500);
  });
});

describe("PUT /api/console/preferences", () => {
  it("401s without a token", async () => {
    setAuthEnv({
      AUTH_PROVIDER: "okta",
      OKTA_ISSUER: "https://integrator-1234567.okta.com/oauth2/default",
      OKTA_CLIENT_ID: "0oaTESTclientid",
    });
    expect((await put({ theme: "dark" })).status).toBe(401);
  });

  it("409s when the layer is not configured, so the UI keeps using the browser", async () => {
    setAuthEnv(USER);
    const res = await put({ theme: "dark" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("browser");
    expect(ssmWrites()).toHaveLength(0);
  });

  it("400s a body that is not JSON, and an invalid body, writing nothing", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    expect((await put("{oops", true)).status).toBe(400);
    const res = await put({ defaultApp: "billing" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("preferences.defaultApp");
    expect((await put({ theme: "sepia" })).status).toBe(400);
    expect((await put({ colour: "red" })).status).toBe(400);
    expect(ssmWrites()).toHaveLength(0);
  });

  it("stores the caller's row under the hashed name and echoes it back", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    const prefs = { defaultApp: "pipeline", railCollapsed: true, theme: "dark" };
    const res = await put(prefs);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(prefs);
    const name = preferencesParameterName("anonymous", PREFIX);
    expect(JSON.parse(fake.store.get(name)!)).toEqual(prefs);
    expect([...fake.store.keys()]).toEqual([name]);
    // Round trip through GET.
    expect(await (await get()).json()).toEqual(prefs);
  });

  it("cannot be steered to another user's row by the body", async () => {
    setAuthEnv({ ...USER, CONSOLE_SETTINGS_PREFIX: PREFIX });
    // There is no field for it, so the strict validator refuses the attempt outright.
    expect((await put({ subject: "00uSOMEONE", theme: "dark" })).status).toBe(400);
    expect(fake.store.size).toBe(0);
  });
});

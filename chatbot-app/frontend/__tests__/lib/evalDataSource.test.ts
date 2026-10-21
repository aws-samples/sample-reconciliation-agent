// @vitest-environment node
/**
 * `activeBackend` and `evalDataSource`: which backend's sessions an evaluation scores.
 *
 * Pinned before the SSM plumbing moved to `lib/server/ssm.ts`. The selector defaults to "runtime"
 * whenever its parameter is absent, unreadable or holds anything but the two known ids — an
 * evaluation must not fail because the selector could not be read — and it is cached for 30 s. The
 * data source refuses a backend with no wired service name rather than scoring zero sessions under a
 * name nothing emits.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ssmModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";
import { parameterNotFound } from "../helpers/fakeSsm";

const env = scopedEnv(
  [
    "AGENT_BACKEND_PARAM",
    "BACKEND_SERVICE_NAMES",
    "BACKEND_EVENT_LOG_GROUPS",
    "HARNESS_LOG_GROUP",
  ],
  { AWS_REGION: "us-east-1" },
);
afterAll(() => env.restore());

const ssmSend = vi.fn();
vi.mock("@aws-sdk/client-ssm", () => ssmModule(ssmSend));

/** The module reads its environment and keeps its cache at module scope, so every case loads a fresh copy. */
async function load() {
  vi.resetModules();
  return import("@/lib/evalDataSource");
}

beforeEach(() => {
  vi.clearAllMocks();
  env.set({
    AGENT_BACKEND_PARAM: "/recon-test/agent-backend",
    BACKEND_SERVICE_NAMES: JSON.stringify({
      runtime: "recon-runtime",
      harness: "recon-harness",
    }),
    BACKEND_EVENT_LOG_GROUPS: JSON.stringify({
      harness: "/aws/harness/events",
    }),
    HARNESS_LOG_GROUP: undefined,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("activeBackend", () => {
  it("reads the stored selector, trimmed and case-folded", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: " Harness " } });
    const { activeBackend } = await load();

    expect(await activeBackend()).toBe("harness");
    expect(ssmSend.mock.calls[0][0]).toMatchObject({
      __cmd: "Get",
      Name: "/recon-test/agent-backend",
    });
  });

  it("defaults to runtime when the parameter does not exist", async () => {
    ssmSend.mockRejectedValue(parameterNotFound());
    const { activeBackend } = await load();
    expect(await activeBackend()).toBe("runtime");
  });

  it("defaults to runtime when the parameter cannot be read at all", async () => {
    // Deliberately broader than "not found": a permissions failure on the selector must not turn a
    // batch evaluation into an error. The default stands and the batch runs against the runtime.
    ssmSend.mockRejectedValue(new Error("AccessDeniedException"));
    const { activeBackend } = await load();
    expect(await activeBackend()).toBe("runtime");
  });

  it("defaults to runtime for a value that names neither backend", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "nonesuch" } });
    const { activeBackend } = await load();
    expect(await activeBackend()).toBe("runtime");
  });

  it("never touches SSM when no parameter name is wired", async () => {
    env.set({ AGENT_BACKEND_PARAM: undefined });
    const { activeBackend } = await load();

    expect(await activeBackend()).toBe("runtime");
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("caches the selector for 30 seconds", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "harness" } });
    const { activeBackend } = await load();

    await activeBackend();
    await activeBackend();
    expect(ssmSend).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    await activeBackend();
    expect(ssmSend).toHaveBeenCalledTimes(2);
  });
});

describe("evalDataSource", () => {
  it("pairs the spans log group with the backend's event log group", async () => {
    const { evalDataSource } = await load();
    expect(await evalDataSource("harness")).toEqual({
      backend: "harness",
      serviceName: "recon-harness",
      logGroupNames: ["aws/spans", "/aws/harness/events"],
    });
    // Named explicitly, so the read is not one SSM call away from a different answer.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("uses the spans log group alone when the backend has no event log group", async () => {
    const { evalDataSource } = await load();
    expect((await evalDataSource("runtime")).logGroupNames).toEqual([
      "aws/spans",
    ]);
  });

  it("resolves the active backend when none is given", async () => {
    ssmSend.mockResolvedValue({ Parameter: { Value: "harness" } });
    const { evalDataSource } = await load();
    expect((await evalDataSource()).backend).toBe("harness");
  });

  it("refuses a backend with no wired service name", async () => {
    const { evalDataSource } = await load();
    await expect(evalDataSource("nonesuch")).rejects.toThrow(
      /No OTel service name wired for backend "nonesuch"/,
    );
  });
});

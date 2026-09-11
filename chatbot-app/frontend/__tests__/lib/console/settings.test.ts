// @vitest-environment node
/**
 * The console settings layer against an in-memory Parameter Store.
 *
 * Three properties carry the weight. Precedence: a stored value beats the environment and a blank
 * stored value falls back to it, because that is the contract every Settings screen explains. Fail
 * open: when the prefix is unset or SSM is unreachable, `effectiveEnv()` is the process environment
 * and the console keeps working, with one warning per cache window rather than one per request.
 * Isolation: preferences are keyed by a hash of the subject, so two users can never read each
 * other's row and the parameter listing never spells out an identifier.
 *
 * Node environment: `settings.ts` imports `api-auth` (for the anonymous switch), which pulls in jose,
 * whose `instanceof Uint8Array` check fails across realms under jsdom.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthEnv, restoreAuthEnv, setAuthEnv, snapshotAuthEnv } from "../auth/testEnv";
import { createFakeSsm, ssmCommandMocks, type FakeSsm, type FakeSsmCommand } from "./fakeSsm";

const ssmSend = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  ...ssmCommandMocks((impl) => vi.fn().mockImplementation(impl as never) as never),
}));

const {
  ConsoleNotConfiguredError,
  OVERLAY_TTL_MS,
  consoleDefaultModelId,
  consoleSettingsPrefix,
  effectiveEnv,
  getConsoleSettings,
  getPreferences,
  invalidate,
  isConsoleAdmin,
  isConsoleConfigured,
  loadOverlay,
  organizationLabel,
  overlayFromStored,
  preferencesParameterName,
  putPreferences,
  updateConsoleSettings,
} = await import("@/lib/console/settings");
const { ConsoleValidationError } = await import("@/lib/console/validation");

const PREFIX = "/recon-test/console";

let fake: FakeSsm;
const saved = snapshotAuthEnv();

beforeEach(() => {
  clearAuthEnv();
  fake = createFakeSsm();
  ssmSend.mockReset();
  ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
  invalidate();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => restoreAuthEnv(saved));

/** The `GetParametersByPath` calls made so far, by path. */
function pathReads(): string[] {
  return ssmSend.mock.calls
    .map(([cmd]) => cmd as FakeSsmCommand)
    .filter((cmd) => cmd.__cmd === "GetByPath")
    .map((cmd) => cmd.Path ?? "");
}

describe("consoleSettingsPrefix", () => {
  it("is empty (disabled) when unset or blank", () => {
    expect(consoleSettingsPrefix({})).toBe("");
    expect(consoleSettingsPrefix({ CONSOLE_SETTINGS_PREFIX: "   " })).toBe("");
    expect(isConsoleConfigured({})).toBe(false);
  });

  it("trims and drops trailing slashes so parameter names never contain //", () => {
    expect(consoleSettingsPrefix({ CONSOLE_SETTINGS_PREFIX: "  /x/console/  " })).toBe("/x/console");
    expect(consoleSettingsPrefix({ CONSOLE_SETTINGS_PREFIX: "/x/console///" })).toBe("/x/console");
    expect(isConsoleConfigured({ CONSOLE_SETTINGS_PREFIX: "/x/console" })).toBe(true);
  });
});

describe("isConsoleAdmin", () => {
  it("admits a member of the configured group", () => {
    expect(isConsoleAdmin(["x", "console-admins"], { CONSOLE_ADMIN_GROUP: "console-admins" })).toBe(true);
  });

  it("admits nobody when the group is unset or blank", () => {
    // Fail closed, like the app admin helpers: a deployment that lost the variable must not make
    // every authenticated user a console admin.
    expect(isConsoleAdmin(["console-admins"], {})).toBe(false);
    expect(isConsoleAdmin(["", "  "], { CONSOLE_ADMIN_GROUP: "  " })).toBe(false);
  });

  it("trims the configured name and matches exactly", () => {
    expect(isConsoleAdmin(["console-admins"], { CONSOLE_ADMIN_GROUP: " console-admins " })).toBe(true);
    expect(isConsoleAdmin(["Console-Admins", "console-admins-ro"], { CONSOLE_ADMIN_GROUP: "console-admins" })).toBe(false);
  });
});

describe("effectiveEnv when the layer is disabled", () => {
  it("returns process.env itself and never touches SSM", async () => {
    setAuthEnv({ RECON_ACCESS_GROUP: "env-users" });
    expect(await effectiveEnv()).toBe(process.env);
    expect(await loadOverlay()).toEqual({});
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

describe("overlayFromStored", () => {
  it("maps the access and apps subtrees onto the registry's environment names", () => {
    expect(
      overlayFromStored({
        "access/recon/access-group": "recon-users",
        "access/recon/admin-group": "recon-admin",
        "access/pipeline/access-group": "deal-desk",
        "access/pipeline/admin-group": "deal-desk-admins",
        "apps/pipeline/enabled": "false",
      }),
    ).toEqual({
      RECON_ACCESS_GROUP: "recon-users",
      RECON_ADMIN_GROUP: "recon-admin",
      PIPELINE_ACCESS_GROUP: "deal-desk",
      PIPELINE_ADMIN_GROUP: "deal-desk-admins",
      PIPELINE_ENABLED: "false",
    });
  });

  it("ignores parameters for unknown apps, unknown keys, and an enabled flag for an always-on app", () => {
    // `apps/recon/enabled` has no environment twin (recon has no `enabledEnv`), so it must map to
    // nothing rather than invent a variable the registry does not read.
    expect(
      overlayFromStored({
        "access/other/access-group": "x",
        "access/recon/colour": "blue",
        "apps/recon/enabled": "false",
        "defaults/model-id": "m",
      }),
    ).toEqual({});
  });
});

describe("effectiveEnv with a configured layer", () => {
  beforeEach(() => setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX }));

  it("lets a stored group beat the environment", async () => {
    setAuthEnv({ RECON_ACCESS_GROUP: "env-users", RECON_ADMIN_GROUP: "env-admin" });
    fake.seed(PREFIX, { "access/recon/access-group": "stored-users" });
    const env = await effectiveEnv();
    expect(env.RECON_ACCESS_GROUP).toBe("stored-users");
    // Not stored: the environment shows through.
    expect(env.RECON_ADMIN_GROUP).toBe("env-admin");
    // Everything else in the process environment is still there.
    expect(env.CONSOLE_SETTINGS_PREFIX).toBe(PREFIX);
  });

  it("lets a blank stored value fall back to the environment", async () => {
    setAuthEnv({ RECON_ACCESS_GROUP: "env-users" });
    fake.seed(PREFIX, { "access/recon/access-group": "   ", "access/recon/admin-group": "" });
    const env = await effectiveEnv();
    expect(env.RECON_ACCESS_GROUP).toBe("env-users");
    expect(env.RECON_ADMIN_GROUP).toBeUndefined();
  });

  it("trims stored values so they compare equal to what the registry trims", async () => {
    fake.seed(PREFIX, { "access/pipeline/admin-group": "  deal-desk-admins  ", "apps/pipeline/enabled": " false " });
    const env = await effectiveEnv();
    expect(env.PIPELINE_ADMIN_GROUP).toBe("deal-desk-admins");
    expect(env.PIPELINE_ENABLED).toBe("false");
  });

  it("never overlays the environment-only switches, whatever is stored", async () => {
    // A stored parameter that happens to spell one of these names must not reach the decision: the
    // mapping is by registry entry, not by name, so there is no path for it.
    fake.store.set(`${PREFIX}/access/REQUIRE_ACCESS_GROUPS`, "false");
    fake.store.set(`${PREFIX}/apps/CONSOLE_ADMIN_GROUP`, "everyone");
    fake.store.set(`${PREFIX}/access/recon/ALLOW_ANONYMOUS_API`, "true");
    const overlay = await loadOverlay();
    expect(overlay).toEqual({});
  });

  it("does not consult the prefs subtree, and reads the others with pagination", async () => {
    fake = createFakeSsm(2);
    ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
    fake.seed(PREFIX, {
      "access/recon/access-group": "a",
      "access/recon/admin-group": "b",
      "access/pipeline/access-group": "c",
      "access/pipeline/admin-group": "d",
      "apps/pipeline/enabled": "true",
      "prefs/0123456789abcdef0123456789abcdef": '{"theme":"dark"}',
    });
    expect(await loadOverlay()).toEqual({
      RECON_ACCESS_GROUP: "a",
      RECON_ADMIN_GROUP: "b",
      PIPELINE_ACCESS_GROUP: "c",
      PIPELINE_ADMIN_GROUP: "d",
      PIPELINE_ENABLED: "true",
    });
    const reads = pathReads();
    // Four access parameters at two per page = two pages for that subtree alone.
    expect(reads.filter((p) => p === `${PREFIX}/access`)).toHaveLength(2);
    expect(reads).not.toContain(`${PREFIX}/prefs`);
    expect(new Set(reads)).toEqual(
      new Set([`${PREFIX}/access`, `${PREFIX}/apps`, `${PREFIX}/defaults`, `${PREFIX}/meta`]),
    );
    for (const [cmd] of ssmSend.mock.calls) {
      expect((cmd as FakeSsmCommand).Recursive).toBe(true);
    }
  });
});

describe("the overlay cache", () => {
  beforeEach(() => setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX }));

  it("serves repeated reads from one snapshot within the TTL", async () => {
    fake.seed(PREFIX, { "access/recon/access-group": "v1" });
    await effectiveEnv();
    const firstRound = ssmSend.mock.calls.length;
    expect(firstRound).toBeGreaterThan(0);
    // A change in the store is invisible until the snapshot expires: propagation between instances
    // relies on exactly this window.
    fake.store.set(`${PREFIX}/access/recon/access-group`, "v2");
    expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("v1");
    expect((await loadOverlay()).RECON_ACCESS_GROUP).toBe("v1");
    expect(ssmSend.mock.calls.length).toBe(firstRound);
  });

  it("re-reads once the TTL has passed", async () => {
    vi.useFakeTimers();
    fake.seed(PREFIX, { "access/recon/access-group": "v1" });
    await effectiveEnv();
    const firstRound = ssmSend.mock.calls.length;
    fake.store.set(`${PREFIX}/access/recon/access-group`, "v2");
    vi.advanceTimersByTime(OVERLAY_TTL_MS - 1);
    expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("v1");
    vi.advanceTimersByTime(2);
    expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("v2");
    expect(ssmSend.mock.calls.length).toBe(firstRound * 2);
  });

  it("re-reads immediately after invalidate()", async () => {
    fake.seed(PREFIX, { "access/recon/access-group": "v1" });
    await effectiveEnv();
    fake.store.set(`${PREFIX}/access/recon/access-group`, "v2");
    invalidate();
    expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("v2");
  });

  it("shares one in-flight read between concurrent callers", async () => {
    fake.seed(PREFIX, { "access/recon/access-group": "v1" });
    const [a, b, c] = await Promise.all([effectiveEnv(), effectiveEnv(), loadOverlay()]);
    expect(a.RECON_ACCESS_GROUP).toBe("v1");
    expect(b.RECON_ACCESS_GROUP).toBe("v1");
    expect(c.RECON_ACCESS_GROUP).toBe("v1");
    // One read per subtree, not three.
    expect(pathReads().filter((p) => p === `${PREFIX}/access`)).toHaveLength(1);
  });
});

describe("effectiveEnv when SSM fails", () => {
  beforeEach(() => setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX, RECON_ACCESS_GROUP: "env-users" }));

  it("falls back to the environment and warns once per TTL window", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ssmSend.mockRejectedValue(new Error("AccessDeniedException: not authorized"));
      const env = await effectiveEnv();
      // Fail OPEN to env: a Parameter Store hiccup must never lock the console.
      expect(env.RECON_ACCESS_GROUP).toBe("env-users");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(PREFIX);
      expect(String(warn.mock.calls[0][0])).toContain("AccessDeniedException");
      const callsAfterFailure = ssmSend.mock.calls.length;
      // Within the window: no retry, no second warning, still the environment.
      expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("env-users");
      expect(await loadOverlay()).toEqual({});
      expect(ssmSend.mock.calls.length).toBe(callsAfterFailure);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries after the window, warning again only if it still fails", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ssmSend.mockRejectedValue(new Error("ThrottlingException"));
      await effectiveEnv();
      expect(warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(OVERLAY_TTL_MS + 1);
      await effectiveEnv();
      expect(warn).toHaveBeenCalledTimes(2);
      // Recovered: the stored value applies and nothing more is logged.
      ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
      fake.seed(PREFIX, { "access/recon/access-group": "stored-users" });
      vi.advanceTimersByTime(OVERLAY_TTL_MS + 1);
      expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("stored-users");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("retries at once after invalidate()", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      ssmSend.mockRejectedValue(new Error("boom"));
      await effectiveEnv();
      ssmSend.mockImplementation((cmd: FakeSsmCommand) => fake.send(cmd));
      fake.seed(PREFIX, { "access/recon/access-group": "stored-users" });
      invalidate();
      expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("stored-users");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("getConsoleSettings", () => {
  it("reports everything from env or default when the layer is disabled", async () => {
    setAuthEnv({
      RECON_ACCESS_GROUP: " recon-users ",
      PIPELINE_ENABLED: "false",
      REQUIRE_ACCESS_GROUPS: "true",
      ALLOW_ANONYMOUS_API: "true",
      CONSOLE_ADMIN_GROUP: "console-admins",
    });
    const s = await getConsoleSettings();
    expect(s.configured).toBe(false);
    expect(s.prefix).toBeNull();
    expect(s.access.recon.accessGroup).toEqual({ value: "recon-users", source: "env", envName: "RECON_ACCESS_GROUP" });
    expect(s.access.recon.adminGroup).toEqual({ value: "", source: "default", envName: "RECON_ADMIN_GROUP" });
    expect(s.access.pipeline.accessGroup.source).toBe("default");
    // Recon has no enablement variable, so it is not listed; the pipeline is, from env.
    expect(Object.keys(s.apps)).toEqual(["pipeline"]);
    expect(s.apps.pipeline!.enabled).toEqual({ value: "false", source: "env", envName: "PIPELINE_ENABLED" });
    expect(s.defaults.modelId).toEqual({ value: "", source: "default", envName: "CONSOLE_DEFAULT_MODEL_ID" });
    expect(s.defaults.organizationLabel).toEqual({
      value: "Agentic Operations Console",
      source: "default",
      envName: "CONSOLE_ORGANIZATION_LABEL",
    });
    expect(s.envOnly).toEqual({ requireAccessGroups: true, anonymousMode: true, consoleAdminGroup: "console-admins" });
    expect(s.updatedAt).toBeUndefined();
    expect(s.updatedBy).toBeUndefined();
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("reports each field's source: stored beats env beats default", async () => {
    setAuthEnv({
      CONSOLE_SETTINGS_PREFIX: PREFIX,
      RECON_ACCESS_GROUP: "env-users",
      RECON_ADMIN_GROUP: "env-admin",
      CONSOLE_ORGANIZATION_LABEL: "Env Label",
      CONSOLE_DEFAULT_MODEL_ID: "env.model",
    });
    fake.seed(PREFIX, {
      "access/recon/access-group": "stored-users",
      "apps/pipeline/enabled": "false",
      "defaults/organization-label": "Northwind Capital",
      "meta/updated": JSON.stringify({ at: "2026-09-11T10:00:00.000Z", by: "00uADMIN" }),
    });
    const s = await getConsoleSettings();
    expect(s.configured).toBe(true);
    expect(s.prefix).toBe(PREFIX);
    expect(s.access.recon.accessGroup).toEqual({ value: "stored-users", source: "stored", envName: "RECON_ACCESS_GROUP" });
    expect(s.access.recon.adminGroup).toEqual({ value: "env-admin", source: "env", envName: "RECON_ADMIN_GROUP" });
    expect(s.access.pipeline.adminGroup.source).toBe("default");
    expect(s.apps.pipeline!.enabled).toEqual({ value: "false", source: "stored", envName: "PIPELINE_ENABLED" });
    expect(s.defaults.organizationLabel).toEqual({
      value: "Northwind Capital",
      source: "stored",
      envName: "CONSOLE_ORGANIZATION_LABEL",
    });
    expect(s.defaults.modelId).toEqual({ value: "env.model", source: "env", envName: "CONSOLE_DEFAULT_MODEL_ID" });
    expect(s.updatedAt).toBe("2026-09-11T10:00:00.000Z");
    expect(s.updatedBy).toBe("00uADMIN");
  });

  it("normalises a stored enablement flag to true/false and defaults to enabled", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "apps/pipeline/enabled": "yes" });
    // Only the literal "false" disables (the registry's rule), so "yes" reads as enabled, from stored.
    expect((await getConsoleSettings()).apps.pipeline!.enabled).toEqual({
      value: "true",
      source: "stored",
      envName: "PIPELINE_ENABLED",
    });
    invalidate();
    fake.store.clear();
    expect((await getConsoleSettings()).apps.pipeline!.enabled).toEqual({
      value: "true",
      source: "default",
      envName: "PIPELINE_ENABLED",
    });
  });

  it("survives an unparseable meta/updated rather than failing the screen", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "meta/updated": "not json" });
    const s = await getConsoleSettings();
    expect(s.updatedAt).toBeUndefined();
  });

  it("does NOT fail open: an admin must see the read error", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockRejectedValue(new Error("AccessDeniedException"));
    await expect(getConsoleSettings()).rejects.toThrow("AccessDeniedException");
  });
});

describe("updateConsoleSettings", () => {
  it("refuses when the layer is disabled", async () => {
    await expect(updateConsoleSettings({ defaults: { modelId: "m" } }, "actor")).rejects.toBeInstanceOf(
      ConsoleNotConfiguredError,
    );
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("writes nothing when any field is invalid", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    await expect(
      updateConsoleSettings(
        { access: { recon: { accessGroup: "ok-group", adminGroup: "bad;group" } } },
        "actor",
      ),
    ).rejects.toBeInstanceOf(ConsoleValidationError);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("puts present fields, deletes cleared ones, records who and when, and refreshes the cache", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-11T12:34:56.000Z"));
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX, RECON_ADMIN_GROUP: "env-admin" });
    fake.seed(PREFIX, { "access/recon/admin-group": "old-admin", "defaults/model-id": "old.model" });
    // Prime the cache so the test proves the write invalidates it.
    expect((await effectiveEnv()).RECON_ADMIN_GROUP).toBe("old-admin");

    const result = await updateConsoleSettings(
      {
        access: { recon: { accessGroup: " recon-users ", adminGroup: "" }, pipeline: { adminGroup: "deal-desk-admins" } },
        apps: { pipeline: { enabled: false } },
        defaults: { modelId: "", organizationLabel: "Northwind Capital" },
      },
      "00uADMIN",
    );

    // What is now in Parameter Store.
    expect(fake.store.get(`${PREFIX}/access/recon/access-group`)).toBe("recon-users");
    expect(fake.store.has(`${PREFIX}/access/recon/admin-group`)).toBe(false);
    expect(fake.store.get(`${PREFIX}/access/pipeline/admin-group`)).toBe("deal-desk-admins");
    expect(fake.store.get(`${PREFIX}/apps/pipeline/enabled`)).toBe("false");
    expect(fake.store.has(`${PREFIX}/defaults/model-id`)).toBe(false);
    expect(fake.store.get(`${PREFIX}/defaults/organization-label`)).toBe("Northwind Capital");
    expect(JSON.parse(fake.store.get(`${PREFIX}/meta/updated`)!)).toEqual({
      at: "2026-09-11T12:34:56.000Z",
      by: "00uADMIN",
    });

    // How it was written: String, Overwrite, and a delete for each "".
    const puts = ssmSend.mock.calls.map(([c]) => c as FakeSsmCommand).filter((c) => c.__cmd === "Put");
    expect(puts.length).toBeGreaterThan(0);
    for (const put of puts) expect(put).toMatchObject({ Type: "String", Overwrite: true });
    const deletes = ssmSend.mock.calls.map(([c]) => c as FakeSsmCommand).filter((c) => c.__cmd === "Delete");
    expect(deletes.map((d) => d.Name).sort()).toEqual(
      [`${PREFIX}/access/recon/admin-group`, `${PREFIX}/defaults/model-id`].sort(),
    );

    // The returned view reflects the write, with sources.
    expect(result.access.recon.accessGroup).toEqual({ value: "recon-users", source: "stored", envName: "RECON_ACCESS_GROUP" });
    expect(result.access.recon.adminGroup).toEqual({ value: "env-admin", source: "env", envName: "RECON_ADMIN_GROUP" });
    expect(result.apps.pipeline!.enabled.value).toBe("false");
    expect(result.defaults.modelId.source).toBe("default");
    expect(result.updatedBy).toBe("00uADMIN");
    expect(result.updatedAt).toBe("2026-09-11T12:34:56.000Z");

    // And the access path sees it at once on this instance.
    const env = await effectiveEnv();
    expect(env.RECON_ADMIN_GROUP).toBe("env-admin");
    expect(env.RECON_ACCESS_GROUP).toBe("recon-users");
    expect(env.PIPELINE_ENABLED).toBe("false");
  });

  it("treats deleting an absent parameter as success", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    // Nothing stored; clearing must still succeed (the setting is already "from env").
    const result = await updateConsoleSettings({ access: { recon: { accessGroup: "" } } }, "actor");
    expect(result.access.recon.accessGroup.source).toBe("default");
  });

  it("propagates any other delete failure", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockImplementation(async (cmd: FakeSsmCommand) => {
      if (cmd.__cmd === "Delete") throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      return fake.send(cmd);
    });
    await expect(updateConsoleSettings({ access: { recon: { accessGroup: "" } } }, "actor")).rejects.toThrow("denied");
  });
});

describe("organizationLabel and consoleDefaultModelId", () => {
  it("resolve stored -> env -> default", async () => {
    expect(await organizationLabel()).toBe("Agentic Operations Console");
    expect(await consoleDefaultModelId()).toBeNull();

    setAuthEnv({ CONSOLE_ORGANIZATION_LABEL: " Env Label ", CONSOLE_DEFAULT_MODEL_ID: "env.model" });
    expect(await organizationLabel()).toBe("Env Label");
    expect(await consoleDefaultModelId()).toBe("env.model");

    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "defaults/organization-label": "Northwind Capital", "defaults/model-id": "us.example.model-v2:0" });
    invalidate();
    expect(await organizationLabel()).toBe("Northwind Capital");
    expect(await consoleDefaultModelId()).toBe("us.example.model-v2:0");
  });

  it("come from the same cached snapshot as the overlay", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.seed(PREFIX, { "defaults/organization-label": "Northwind Capital" });
    await effectiveEnv();
    const calls = ssmSend.mock.calls.length;
    expect(await organizationLabel()).toBe("Northwind Capital");
    expect(await consoleDefaultModelId()).toBeNull();
    expect(ssmSend.mock.calls.length).toBe(calls);
  });
});

describe("preferences", () => {
  it("names the row by the first 32 hex characters of sha256(subject), under prefs/", () => {
    // sha256("00uALICE") is stable; pin the shape rather than the digest so the test documents the rule.
    const name = preferencesParameterName("00uALICE", PREFIX);
    expect(name).toMatch(new RegExp(`^${PREFIX}/prefs/[0-9a-f]{32}$`));
    expect(preferencesParameterName("00uALICE", PREFIX)).toBe(name);
    expect(preferencesParameterName("00uBOB", PREFIX)).not.toBe(name);
    // The identifier itself never appears in the parameter name.
    expect(name).not.toContain("00uALICE");
  });

  it("reads {} when the layer is disabled, without touching SSM", async () => {
    expect(await getPreferences("00uALICE")).toEqual({});
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("reads {} for a subject with no row, and for a row that is not JSON", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    expect(await getPreferences("00uALICE")).toEqual({});
    fake.store.set(preferencesParameterName("00uALICE", PREFIX), "{not json");
    expect(await getPreferences("00uALICE")).toEqual({});
  });

  it("drops fields it does not understand on read rather than failing", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    fake.store.set(
      preferencesParameterName("00uALICE", PREFIX),
      JSON.stringify({ defaultApp: "nope", railCollapsed: "yes", theme: "dark", future: 1 }),
    );
    expect(await getPreferences("00uALICE")).toEqual({ theme: "dark" });
  });

  it("propagates a read failure other than not-found", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    ssmSend.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDeniedException" }));
    await expect(getPreferences("00uALICE")).rejects.toThrow("denied");
  });

  it("refuses to write when the layer is disabled", async () => {
    await expect(putPreferences("00uALICE", { theme: "dark" })).rejects.toBeInstanceOf(ConsoleNotConfiguredError);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("validates strictly on write", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    await expect(putPreferences("00uALICE", { defaultApp: "nope" })).rejects.toBeInstanceOf(ConsoleValidationError);
    await expect(putPreferences("00uALICE", { theme: "sepia" })).rejects.toBeInstanceOf(ConsoleValidationError);
    await expect(putPreferences("00uALICE", { future: true })).rejects.toBeInstanceOf(ConsoleValidationError);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("stores JSON at the hashed name and keeps subjects apart", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    const alice = { defaultApp: "pipeline" as const, railCollapsed: true, theme: "dark" as const };
    expect(await putPreferences("00uALICE", alice)).toEqual(alice);
    expect(JSON.parse(fake.store.get(preferencesParameterName("00uALICE", PREFIX))!)).toEqual(alice);
    const put = ssmSend.mock.calls.map(([c]) => c as FakeSsmCommand).find((c) => c.__cmd === "Put");
    expect(put).toMatchObject({ Type: "String", Overwrite: true });

    expect(await getPreferences("00uALICE")).toEqual(alice);
    // Bob has no row: he must not see Alice's.
    expect(await getPreferences("00uBOB")).toEqual({});
    await putPreferences("00uBOB", { theme: "light" });
    expect(await getPreferences("00uBOB")).toEqual({ theme: "light" });
    expect(await getPreferences("00uALICE")).toEqual(alice);
  });

  it("replaces the whole document on write", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX });
    await putPreferences("00uALICE", { theme: "dark", railCollapsed: true });
    await putPreferences("00uALICE", { theme: "light" });
    expect(await getPreferences("00uALICE")).toEqual({ theme: "light" });
  });
});


describe("deployment truth for app enablement", () => {
  it("drops a stored \"true\" from the overlay when the environment says the app is not deployed", () => {
    const stored = { "apps/pipeline/enabled": "true" };
    expect(overlayFromStored(stored, { PIPELINE_ENABLED: "false" })).toEqual({});
    expect(overlayFromStored(stored, { PIPELINE_ENABLED: "true" })).toEqual({ PIPELINE_ENABLED: "true" });
    expect(overlayFromStored(stored, {})).toEqual({ PIPELINE_ENABLED: "true" });
  });

  it("reports the environment as the source when it says not deployed, even with a stored value", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX, PIPELINE_ENABLED: "false" });
    fake.seed(PREFIX, { "apps/pipeline/enabled": "true" });
    expect((await getConsoleSettings()).apps.pipeline!.enabled).toEqual({
      value: "false",
      source: "env",
      envName: "PIPELINE_ENABLED",
    });
  });

  it("refuses to enable an app the deployment does not have, writing nothing", async () => {
    setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX, PIPELINE_ENABLED: "false" });
    await expect(
      updateConsoleSettings({ apps: { pipeline: { enabled: true } } }, "actor"),
    ).rejects.toThrow(/not deployed on this console/);
    expect(ssmSend.mock.calls.filter(([cmd]) => (cmd as FakeSsmCommand).__cmd === "Put")).toHaveLength(0);
  });
});

describe("effectiveEnv keeps the last snapshot when a later read fails", () => {
  it("serves stale stored values rather than the environment once something was read", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setAuthEnv({ CONSOLE_SETTINGS_PREFIX: PREFIX, RECON_ACCESS_GROUP: "env-users" });
      fake.seed(PREFIX, { "access/recon/access-group": "stored-users" });
      expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("stored-users");
      // The snapshot expires and Parameter Store is down: the restriction that lives only in the
      // stored layer must keep applying.
      vi.advanceTimersByTime(OVERLAY_TTL_MS + 1);
      ssmSend.mockRejectedValue(new Error("ThrottlingException"));
      expect((await effectiveEnv()).RECON_ACCESS_GROUP).toBe("stored-users");
      expect(String(warn.mock.calls[0][0])).toContain("Serving the last snapshot");
    } finally {
      warn.mockRestore();
    }
  });
});

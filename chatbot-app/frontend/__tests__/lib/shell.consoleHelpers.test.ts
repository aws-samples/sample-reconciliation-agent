/**
 * The pure pieces behind the console Settings screen.
 *
 * Preferences are validated field by field because two of them steer behaviour; the console path
 * test guards the shell's "this is not an app" branch; the form helpers pin that a save carries ONLY
 * what changed (an env value merely displayed must never become a stored one) and that "" is the
 * legitimate way to clear; and the tab resolver pins where each kind of viewer lands.
 */
import { describe, expect, it } from "vitest";

import { resolveSettingsTab, settingsTabHref } from "@/components/console/tabs";
import { composeModelId, splitModelId } from "@/components/console/modelPresets";
import type { ConsoleSettings } from "@/lib/console/types";
import { CONSOLE_SETTINGS_PATH, isConsolePath } from "@/lib/shell/consolePaths";
import {
  accessDraftError,
  accessDraftFrom,
  accessUpdateFrom,
  groupNameError,
  modelIdError,
  organizationLabelError,
  parseGroupList,
} from "@/lib/shell/consoleSettingsForm";
import { normalizePreferences } from "@/lib/shell/preferences";

describe("normalizePreferences", () => {
  it.each([
    [{ defaultApp: "recon" }, { defaultApp: "recon" }],
    [{ defaultApp: "billing" }, {}],
    [{ railCollapsed: false }, { railCollapsed: false }],
    [{ railCollapsed: "false" }, {}],
    [{ theme: "light" }, { theme: "light" }],
    [{ theme: "solarized" }, {}],
    [null, {}],
    ["nonsense", {}],
  ])("%j -> %j", (raw, expected) => {
    expect(normalizePreferences(raw)).toEqual(expected);
  });
});

describe("isConsolePath", () => {
  it.each([
    ["/console", true],
    ["/console/settings", true],
    ["/console/settings?tab=access", true],
    ["/consoles", false],
    ["/recon/dashboard", false],
    ["/", false],
    [null, false],
  ])("%s -> %s", (path, expected) => {
    expect(isConsolePath(path)).toBe(expected);
  });

  it("names the settings path the rail links to", () => {
    expect(CONSOLE_SETTINGS_PATH).toBe("/console/settings");
    expect(settingsTabHref("users")).toBe("/console/settings?tab=users");
  });
});

describe("validation", () => {
  it("accepts a blank group name as the instruction to clear", () => {
    expect(groupNameError("")).toBeNull();
    expect(modelIdError("")).toBeNull();
    expect(organizationLabelError("")).toBeNull();
  });

  it("refuses group names outside the shared pattern or length", () => {
    expect(groupNameError("recon-analysts")).toBeNull();
    expect(groupNameError("Desk Users:EMEA@corp/ops")).toBeNull();
    expect(groupNameError("bad;name")).toMatch(/only/);
    expect(groupNameError("x".repeat(129))).toMatch(/128/);
  });

  it("refuses model ids with spaces and labels over the limit", () => {
    expect(modelIdError("global.anthropic.claude-opus-5")).toBeNull();
    expect(modelIdError("arn:aws:bedrock:us-east-1:123:inference-profile/abc")).toBeNull();
    expect(modelIdError("two words")).toMatch(/no spaces/);
    expect(organizationLabelError("x".repeat(60))).toBeNull();
    expect(organizationLabelError("x".repeat(61))).toMatch(/60/);
  });
});

describe("parseGroupList", () => {
  it("splits on commas, trims, drops blanks and duplicates", () => {
    expect(parseGroupList(" recon-analysts, deal-desk ,, deal-desk,")).toEqual(["recon-analysts", "deal-desk"]);
    expect(parseGroupList("")).toEqual([]);
  });
});

describe("access draft", () => {
  const settings = {
    access: {
      recon: {
        accessGroup: { value: "recon-users", source: "env", envName: "RECON_ACCESS_GROUP" },
        adminGroup: { value: "", source: "default", envName: "RECON_ADMIN_GROUP" },
      },
      pipeline: {
        accessGroup: { value: "deal-desk", source: "stored", envName: "PIPELINE_ACCESS_GROUP" },
        adminGroup: { value: "deal-desk-admins", source: "env", envName: "PIPELINE_ADMIN_GROUP" },
      },
    },
  } as unknown as ConsoleSettings;

  it("starts from the resolved values, whatever their source", () => {
    expect(accessDraftFrom(settings)).toEqual({
      recon: { accessGroup: "recon-users", adminGroup: "" },
      pipeline: { accessGroup: "deal-desk", adminGroup: "deal-desk-admins" },
    });
  });

  it("sends only the fields that changed, including a clear to blank", () => {
    const initial = accessDraftFrom(settings);
    expect(accessUpdateFrom(initial, initial)).toBeUndefined();

    const draft = {
      recon: { accessGroup: "recon-users", adminGroup: "recon-admins" },
      pipeline: { accessGroup: "", adminGroup: "deal-desk-admins" },
    };
    // The untouched env value "recon-users" is NOT in the body: writing it would turn env into stored.
    expect(accessUpdateFrom(initial, draft)).toEqual({
      access: { recon: { adminGroup: "recon-admins" }, pipeline: { accessGroup: "" } },
    });
  });

  it("names the app and field of the first invalid value", () => {
    expect(
      accessDraftError({
        recon: { accessGroup: "ok", adminGroup: "" },
        pipeline: { accessGroup: "", adminGroup: "no;semicolons" },
      }),
    ).toMatch(/^Deal Pipeline admin group:/);
    expect(accessDraftError(accessDraftFrom(settings))).toBeNull();
  });
});

describe("resolveSettingsTab", () => {
  it("honours a known tab, and lands admins on Access and everyone else on Preferences", () => {
    expect(resolveSettingsTab("users", false)).toBe("users");
    expect(resolveSettingsTab("defaults", true)).toBe("defaults");
    expect(resolveSettingsTab(null, true)).toBe("access");
    expect(resolveSettingsTab(null, false)).toBe("preferences");
    expect(resolveSettingsTab("nonsense", true)).toBe("access");
  });
});

describe("model presets", () => {
  it("splits at the first dot and composes back to the same id", () => {
    expect(splitModelId("global.anthropic.claude-opus-5")).toEqual({
      endpoint: "global",
      family: "anthropic.claude-opus-5",
    });
    expect(composeModelId("us", "anthropic.claude-sonnet-5")).toBe("us.anthropic.claude-sonnet-5");
    expect(splitModelId("nodots")).toEqual({ endpoint: "", family: "" });
  });
});

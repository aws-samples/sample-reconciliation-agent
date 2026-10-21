// @vitest-environment node
/**
 * The console layer's write validation, as a table.
 *
 * Pure functions, so every rule the Settings screen quotes back to the operator is pinned here: what
 * a group name may contain, that "" means "clear", that an unknown key is refused rather than
 * ignored, and that a body with one bad field yields no writes at all.
 */
import { describe, expect, it } from "vitest";

import {
  GROUP_NAME_MAX,
  MODEL_ID_MAX,
  ORGANIZATION_LABEL_MAX,
} from "@/lib/console/types";
import {
  ConsoleValidationError,
  normalizePreferences,
  planSettingsUpdate,
  validateGroupName,
  validateModelId,
  validateOrganizationLabel,
  validatePreferences,
} from "@/lib/console/validation";

describe("validateGroupName", () => {
  it("accepts identity-provider spellings, trimmed", () => {
    expect(validateGroupName("recon-admins", "f")).toBe("recon-admins");
    expect(validateGroupName("  Deal Desk Admins ", "f")).toBe("Deal Desk Admins");
    expect(validateGroupName("okta:app/console.admins@corp", "f")).toBe("okta:app/console.admins@corp");
  });

  it("returns empty for a blank, which means clear", () => {
    expect(validateGroupName("", "f")).toBe("");
    expect(validateGroupName("   ", "f")).toBe("");
  });

  it("refuses non-strings, over-long names and stray characters", () => {
    expect(() => validateGroupName(1, "f")).toThrow(ConsoleValidationError);
    expect(() => validateGroupName("a".repeat(GROUP_NAME_MAX + 1), "f")).toThrow(/at most/);
    expect(validateGroupName("a".repeat(GROUP_NAME_MAX), "f")).toHaveLength(GROUP_NAME_MAX);
    // Interior control characters and punctuation the pattern excludes; a TRAILING newline is
    // whitespace and is trimmed away first, which is the intended reading of a paste with a line end.
    for (const bad of ["bad;group", "gro\nup", "name<script>", "tab\there"]) {
      expect(() => validateGroupName(bad, "f"), JSON.stringify(bad)).toThrow(/may contain only/);
    }
    expect(validateGroupName("group\n", "f")).toBe("group");
  });

  it("names the field in the message", () => {
    expect(() => validateGroupName("x;y", "access.recon.accessGroup")).toThrow(/^access\.recon\.accessGroup:/);
  });
});

describe("validateModelId", () => {
  it("accepts model and inference-profile ids", () => {
    expect(validateModelId("us.example.model-v2:0", "f")).toBe("us.example.model-v2:0");
    expect(validateModelId(" arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.example.model ", "f")).toBe(
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.example.model",
    );
    expect(validateModelId("", "f")).toBe("");
  });

  it("refuses spaces, over-long ids and non-strings", () => {
    expect(() => validateModelId("has space", "f")).toThrow(/may contain only/);
    expect(() => validateModelId("a".repeat(MODEL_ID_MAX + 1), "f")).toThrow(/at most/);
    expect(() => validateModelId(null, "f")).toThrow(/must be a string/);
  });
});

describe("validateOrganizationLabel", () => {
  it("accepts any printable text within the limit, trimmed", () => {
    expect(validateOrganizationLabel(" Northwind Capital (EMEA) ", "f")).toBe("Northwind Capital (EMEA)");
    expect(validateOrganizationLabel("Société Générique", "f")).toBe("Société Générique");
    expect(validateOrganizationLabel("", "f")).toBe("");
  });

  it("refuses control characters and over-long labels", () => {
    expect(() => validateOrganizationLabel("two\nlines", "f")).toThrow(/control characters/);
    expect(() => validateOrganizationLabel("a".repeat(ORGANIZATION_LABEL_MAX + 1), "f")).toThrow(/at most/);
  });
});

describe("planSettingsUpdate", () => {
  it("turns present fields into writes and empty strings into deletes, in body order", () => {
    expect(
      planSettingsUpdate({
        access: { recon: { accessGroup: " recon-users ", adminGroup: "" }, pipeline: { adminGroup: "deal-desk-admins" } },
        apps: { pipeline: { enabled: false } },
        defaults: { modelId: "", organizationLabel: "Northwind Capital" },
      }),
    ).toEqual([
      { key: "access/recon/access-group", value: "recon-users" },
      { key: "access/recon/admin-group", value: null },
      { key: "access/pipeline/admin-group", value: "deal-desk-admins" },
      { key: "apps/pipeline/enabled", value: "false" },
      { key: "defaults/model-id", value: null },
      { key: "defaults/organization-label", value: "Northwind Capital" },
    ]);
  });

  it("writes enabled as the literal strings the registry reads", () => {
    expect(planSettingsUpdate({ apps: { pipeline: { enabled: true } } })).toEqual([
      { key: "apps/pipeline/enabled", value: "true" },
    ]);
  });

  it("skips undefined fields and refuses a body that changes nothing", () => {
    expect(planSettingsUpdate({ access: { recon: { accessGroup: "x" } }, defaults: {} })).toEqual([
      { key: "access/recon/access-group", value: "x" },
    ]);
    expect(() => planSettingsUpdate({})).toThrow(/nothing to update/);
    expect(() => planSettingsUpdate({ access: {}, apps: {}, defaults: {} })).toThrow(/nothing to update/);
    expect(() => planSettingsUpdate({ access: { recon: {} } })).toThrow(/nothing to update/);
  });

  it("refuses anything that is not an object", () => {
    for (const bad of [null, undefined, "x", 1, [], true]) {
      expect(() => planSettingsUpdate(bad), String(bad)).toThrow(/must be a JSON object/);
    }
    expect(() => planSettingsUpdate({ access: [] })).toThrow(/access: must be an object/);
    expect(() => planSettingsUpdate({ access: { recon: "x" } })).toThrow(/access\.recon: must be an object/);
  });

  it("refuses unknown keys at every level so a typo cannot silently do nothing", () => {
    expect(() => planSettingsUpdate({ acess: {} })).toThrow(/unknown field "acess"/);
    expect(() => planSettingsUpdate({ access: { recon: { acessGroup: "x" } } })).toThrow(/unknown field "acessGroup"/);
    expect(() => planSettingsUpdate({ apps: { pipeline: { on: true } } })).toThrow(/unknown field "on"/);
    expect(() => planSettingsUpdate({ defaults: { model: "x" } })).toThrow(/unknown field "model"/);
  });

  it("refuses an app the registry does not know", () => {
    expect(() => planSettingsUpdate({ access: { billing: { accessGroup: "x" } } })).toThrow(
      /"billing" is not a registered application/,
    );
    expect(() => planSettingsUpdate({ apps: { billing: { enabled: true } } })).toThrow(/not a registered application/);
  });

  it("refuses a non-boolean enabled and an enabled flag for an always-on app", () => {
    expect(() => planSettingsUpdate({ apps: { pipeline: { enabled: "false" } } })).toThrow(/must be true or false/);
    // Recon has no enablement variable; a stored flag would be read by nothing.
    expect(() => planSettingsUpdate({ apps: { recon: { enabled: false } } })).toThrow(/cannot be disabled/);
  });

  it("validates every field before returning, so one bad field means no writes", () => {
    expect(() =>
      planSettingsUpdate({
        access: { recon: { accessGroup: "fine" } },
        defaults: { organizationLabel: "a".repeat(ORGANIZATION_LABEL_MAX + 1) },
      }),
    ).toThrow(/defaults\.organizationLabel/);
  });
});

describe("validatePreferences (strict, for writes)", () => {
  it("accepts each field and returns only what was present", () => {
    expect(validatePreferences({})).toEqual({});
    expect(validatePreferences({ defaultApp: "recon" })).toEqual({ defaultApp: "recon" });
    expect(validatePreferences({ railCollapsed: false, theme: "system" })).toEqual({ railCollapsed: false, theme: "system" });
  });

  it("refuses unknown keys, unregistered apps, non-boolean flags and unknown themes", () => {
    expect(() => validatePreferences({ colour: "red" })).toThrow(/unknown field "colour"/);
    expect(() => validatePreferences({ defaultApp: "billing" })).toThrow(/not a registered application/);
    expect(() => validatePreferences({ defaultApp: 1 })).toThrow(/must be a string/);
    expect(() => validatePreferences({ railCollapsed: "true" })).toThrow(/must be true or false/);
    expect(() => validatePreferences({ theme: "sepia" })).toThrow(/must be one of system, light, dark/);
    expect(() => validatePreferences([])).toThrow(/must be a JSON object/);
  });
});

describe("normalizePreferences (lenient, for reads)", () => {
  it("keeps valid fields and drops everything else", () => {
    expect(
      normalizePreferences({ defaultApp: "pipeline", railCollapsed: true, theme: "light", future: "x" }),
    ).toEqual({ defaultApp: "pipeline", railCollapsed: true, theme: "light" });
    expect(normalizePreferences({ defaultApp: "billing", railCollapsed: "yes", theme: "sepia" })).toEqual({});
  });

  it("reads anything that is not an object as no preferences", () => {
    for (const raw of [null, undefined, "x", 1, []]) {
      expect(normalizePreferences(raw), String(raw)).toEqual({});
    }
  });
});

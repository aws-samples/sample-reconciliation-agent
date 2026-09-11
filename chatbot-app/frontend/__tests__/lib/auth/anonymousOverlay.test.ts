// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { clearAuthEnv, restoreAuthEnv, setAuthEnv, snapshotAuthEnv } from "./testEnv";

// The anonymous local identity must hold the group names the console's STORED layer uses, not only
// the environment's: an admin who renames a group on the Settings screen would otherwise lose that
// role on their own laptop until the environment caught up.
const effectiveEnv = vi.fn();
vi.mock("@/lib/console/settings", () => ({ effectiveEnv: (...args: unknown[]) => effectiveEnv(...args) }));

const { authorizeRequest } = await import("@/lib/api-auth");

const saved = snapshotAuthEnv();
beforeEach(() => {
  clearAuthEnv();
  effectiveEnv.mockReset();
});
afterAll(() => restoreAuthEnv(saved));

describe("authorizeRequest in anonymous mode", () => {
  it("derives the anonymous groups from the overlaid environment", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", RECON_ADMIN_GROUP: "env-admins" });
    effectiveEnv.mockResolvedValue({ ...process.env, RECON_ADMIN_GROUP: "stored-admins" });
    const result = await authorizeRequest(new Request("http://x/api/me"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe("anonymous");
    expect(result.groups).toContain("stored-admins");
    expect(result.groups).not.toContain("env-admins");
    expect(effectiveEnv).toHaveBeenCalledTimes(1);
  });

  it("still honours ANONYMOUS_GROUPS as the whole list", async () => {
    setAuthEnv({ ALLOW_ANONYMOUS_API: "true", ANONYMOUS_GROUPS: "deal-desk" });
    effectiveEnv.mockResolvedValue({ ...process.env, RECON_ADMIN_GROUP: "stored-admins" });
    const result = await authorizeRequest(new Request("http://x/api/me"));
    expect(result.ok && result.groups).toEqual(["deal-desk"]);
  });
});

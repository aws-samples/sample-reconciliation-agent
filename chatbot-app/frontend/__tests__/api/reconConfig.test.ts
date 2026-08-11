// @vitest-environment node
/**
 * Tests for `/api/recon/config`, focused on the counterparty recipient allowlist.
 *
 * The allowlist is not SSM-backed like the rest of this endpoint's fields — it is baked into the
 * deploy's environment and enforced by the gateway interceptor from its own copy. So the two things
 * worth pinning down are that the GET reports what is actually deployed (the panel draws its inline
 * validation from it) and that the PUT refuses to pretend it can change it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.TIER1_ENABLED_PARAM = "/recon-test/tier1-enabled";
process.env.AUTO_RESOLVE_PARAM = "/recon-test/auto-resolve-threshold";

const ssmSend = vi.fn();

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: ssmSend })),
  GetParameterCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "Get", ...i })),
  PutParameterCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));

const { GET, PUT } = await import("@/app/api/recon/config/route");

function put(body: unknown) {
  return PUT(
    new Request("http://x/api/recon/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every parameter absent, so each field falls back to its deployment default.
  ssmSend.mockRejectedValue(
    Object.assign(new Error("not found"), { name: "ParameterNotFound" }),
  );
});

describe("GET /api/recon/config", () => {
  it("reports the deployed counterparty allowlist, normalized", async () => {
    process.env.COUNTERPARTY_EMAIL_DOMAINS =
      " Partner.Example , other.example ";
    const body = await (await GET()).json();
    expect(body.counterpartyEmailDomains).toEqual([
      "partner.example",
      "other.example",
    ]);
  });

  it("reports an empty allowlist when none is deployed", async () => {
    delete process.env.COUNTERPARTY_EMAIL_DOMAINS;
    const body = await (await GET()).json();
    // Empty means no counterparty email is possible — not "unrestricted". The panel says so.
    expect(body.counterpartyEmailDomains).toEqual([]);
  });
});

describe("PUT /api/recon/config", () => {
  it("refuses a write to the allowlist instead of silently ignoring it", async () => {
    const res = await put({ counterpartyEmailDomains: ["attacker.example"] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deploy-time configuration/);
    // Nothing was stored, and — more importantly — no success was reported for a change the
    // interceptor would never have honored.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("refuses the field even alongside a legitimate change", async () => {
    const res = await put({
      tier1Enabled: false,
      counterpartyEmailDomains: [],
    });
    expect(res.status).toBe(400);
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("still accepts the SSM-backed fields", async () => {
    ssmSend.mockResolvedValue({});
    const res = await put({ tier1Enabled: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier1Enabled: false });
  });
});

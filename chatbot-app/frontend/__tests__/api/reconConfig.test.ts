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
// PUT is admin-gated. Mocked here so these tests stay about the config contract; the gate itself is
// tested in reconAdminGuard.test.ts, and one case below re-checks that this endpoint honours a refusal.
const requireReconAdmin = vi.fn();

vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin }));
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
  requireReconAdmin.mockResolvedValue({ actor: "operator@x.com" });
  // Every parameter absent, so each field falls back to its deployment default.
  ssmSend.mockRejectedValue(
    Object.assign(new Error("not found"), { name: "ParameterNotFound" }),
  );
});

describe("GET /api/recon/config", () => {
  it("never publishes the counterparty allowlist, even when one is deployed", async () => {
    // The allowlist is a GATE and the gateway request interceptor is the gate. Publishing it here let
    // three other places form an opinion about it, each reading a container env var fixed at task
    // start -- so a narrowed allowlist was enforced by the interceptor while the UI still showed the
    // old one. A control that misreports its own configuration is worse than one that says nothing.
    process.env.COUNTERPARTY_EMAIL_DOMAINS =
      " Partner.Example , other.example ";
    const body = await (await GET()).json();
    expect("counterpartyEmailDomains" in body).toBe(false);
  });

  it("reports no model selection as null rather than inventing a default", async () => {
    // Every sibling field substitutes its deployment default here. The model cannot: the default is
    // each BACKEND's environment variable, which this route never sees. Naming a concrete id would
    // claim a selection nobody made, and would be wrong the moment a deploy changed that variable.
    const body = await (await GET()).json();

    expect(body.agentModelId).toBeNull();
    // The options still come from the server, so the UI cannot offer an id the PUT would refuse.
    expect(body.agentModelIds).toContain("us.anthropic.claude-sonnet-5");
  });

  it("surfaces the stored selection", async () => {
    ssmSend.mockResolvedValue({
      Parameter: { Value: "global.anthropic.claude-opus-5" },
    });
    const body = await (await GET()).json();
    expect(body.agentModelId).toBe("global.anthropic.claude-opus-5");
  });

  it("reports a stored id outside the allowlist as no selection", async () => {
    // The agent refuses this value and falls back, so reporting it as the live selection would have
    // the UI vouch for a model that is not being invoked.
    ssmSend.mockResolvedValue({ Parameter: { Value: "some.retired-model" } });
    const body = await (await GET()).json();
    expect(body.agentModelId).toBeNull();
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

  it.each([
    "us.anthropic.claude-opus-5",
    "global.anthropic.claude-opus-5",
    "us.anthropic.claude-sonnet-5",
    "global.anthropic.claude-sonnet-5",
    "us.anthropic.claude-fable-5-1",
    "global.anthropic.claude-fable-5-1",
  ])("stores the selected model %s", async (agentModelId) => {
    ssmSend.mockResolvedValue({});
    const res = await put({ agentModelId });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ agentModelId });
    // Every id the UI offers must actually be writable. The BFF allowlist and the Python one are
    // hand-maintained copies, so an id one side accepts and the other rejects is a save that appears
    // to succeed and then silently falls back to the deployed default.
    expect(ssmSend).toHaveBeenCalledWith(
      expect.objectContaining({ __cmd: "Put", Value: agentModelId }),
    );
  });

  it("rejects an unknown model id without writing anything", async () => {
    ssmSend.mockResolvedValue({});
    const res = await put({
      agentModelId: "us.anthropic.claude-nonexistent-9",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/agentModelId must be one of/);
    // The refusal has to precede the write. A stored unknown id is refused per invocation by the
    // agent instead, which reads as the model selection quietly having no effect.
    expect(ssmSend).not.toHaveBeenCalled();
  });

  it("refuses a non-admin before touching SSM", async () => {
    // The threshold this endpoint writes decides which breaks skip a human entirely, so the refusal has
    // to land before the write rather than being reported after it.
    const { NextResponse } = await import("next/server");
    requireReconAdmin.mockResolvedValue({
      error: NextResponse.json({ error: "not an admin" }, { status: 403 }),
    });

    const res = await put({ autoResolveThreshold: 0.5 });

    expect(res.status).toBe(403);
    expect(ssmSend).not.toHaveBeenCalled();
  });
});

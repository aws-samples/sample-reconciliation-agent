// @vitest-environment node
/**
 * Tests for `/api/recon/config`.
 *
 * Two contracts are pinned here.
 *
 * 1. The counterparty recipient allowlist is not SSM-backed like the rest of this endpoint's fields —
 *    it is baked into the deploy's environment and enforced by the gateway interceptor from its own
 *    copy. So the GET must not report it (the panel would draw inline validation from a stale copy)
 *    and the PUT must refuse to pretend it can change it.
 * 2. The Parameter Store contract. GET reads exactly five parameters, named by `TIER1_ENABLED_PARAM`,
 *    `AUTO_RESOLVE_PARAM`, `COMMENT_REQUIREMENT_PARAM`, `AGENT_BACKEND_PARAM` and `AGENT_MODEL_PARAM`,
 *    and PUT writes each field to its own parameter as a `String` with `Overwrite` and writes nothing
 *    else. The Tier-1 Lambda and both Tier-2 backends read those parameters by name, so a route that
 *    wrote to the wrong one, or to an extra one, would pass every other case in this file and still
 *    change what the agent does.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

import { ssmModule } from "../helpers/awsMocks";
import { scopedEnv } from "../helpers/env";

// The parameter names, keyed by the body field each one backs.
const PARAMS = {
  tier1Enabled: "/recon-test/tier1-enabled",
  autoResolveThreshold: "/recon-test/auto-resolve-threshold",
  commentRequirement: "/recon-test/comment-requirement",
  agentBackend: "/recon-test/agent-backend",
  agentModelId: "/recon-test/agent-model-id",
} as const;

// The route reads its parameter names once at module load, so they are set before the import below.
// `EGRESS_GATEWAY_ARN` is unset explicitly: when it is present, a numeric threshold write also
// rewrites the Cedar policies, which is `lib/reconPolicy`'s contract rather than the one pinned here.
const env = scopedEnv({
  TIER1_ENABLED_PARAM: PARAMS.tier1Enabled,
  AUTO_RESOLVE_PARAM: PARAMS.autoResolveThreshold,
  COMMENT_REQUIREMENT_PARAM: PARAMS.commentRequirement,
  AGENT_BACKEND_PARAM: PARAMS.agentBackend,
  AGENT_MODEL_PARAM: PARAMS.agentModelId,
  EGRESS_GATEWAY_ARN: undefined,
});
afterAll(() => env.restore());

const ssmSend = vi.fn();
// PUT is admin-gated. Mocked here so these tests stay about the config contract; the gate itself is
// tested in reconAdminGuard.test.ts, and one case below re-checks that this endpoint honours a refusal.
const requireReconAdmin = vi.fn();

vi.mock("@/lib/reconAdmin", () => ({ requireReconAdmin }));
vi.mock("@aws-sdk/client-ssm", () => ssmModule(ssmSend));

const { GET, PUT } = await import("@/app/api/recon/config/route");
const { AGENT_MODEL_IDS } = await import("@/lib/server/agentModels");

function put(body: unknown) {
  return PUT(
    new Request("http://x/api/recon/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/** The commands handed to the mocked client, in a stable order so a set can be compared exactly. */
function sentCommands() {
  return ssmSend.mock.calls
    .map((c) => c[0] as { __cmd: string; Name: string })
    .sort((a, b) => a.Name.localeCompare(b.Name));
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
  it("reads the five parameters by name and reports every field with its deployment default", async () => {
    // The names are the contract with the Lambdas and agents that read the same parameters; the body
    // keys are the contract with the Config tab and with the case screen, which reads
    // commentRequirement to decide whether a decision needs a comment.
    const body = await (await GET()).json();

    expect(body).toEqual({
      tier1Enabled: true,
      autoResolveThreshold: 0.85,
      commentRequirement: "disapprove-only",
      agentBackend: "runtime",
      agentModelId: null,
      agentModelIds: AGENT_MODEL_IDS,
    });
    expect(ssmSend).toHaveBeenCalledTimes(5);
    expect(sentCommands()).toEqual(
      Object.values(PARAMS)
        .map((Name) => ({ __cmd: "Get", Name }))
        .sort((a, b) => a.Name.localeCompare(b.Name)),
    );
  });

  it("maps each stored parameter onto its own field", async () => {
    // Distinct values per parameter, so a field reading a sibling's parameter would show up.
    const stored: Record<string, string> = {
      [PARAMS.tier1Enabled]: "false",
      [PARAMS.autoResolveThreshold]: "0.9",
      [PARAMS.commentRequirement]: "required",
      [PARAMS.agentBackend]: "harness",
      [PARAMS.agentModelId]: "us.anthropic.claude-opus-5",
    };
    ssmSend.mockImplementation(async (cmd: { Name: string }) => ({
      Parameter: { Value: stored[cmd.Name] },
    }));

    const body = await (await GET()).json();

    expect(body).toEqual({
      tier1Enabled: false,
      autoResolveThreshold: 0.9,
      commentRequirement: "required",
      agentBackend: "harness",
      agentModelId: "us.anthropic.claude-opus-5",
      agentModelIds: AGENT_MODEL_IDS,
    });
  });

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
  it("writes each field to its own parameter as a String with Overwrite, and nothing else", async () => {
    // Every one of the five parameters is read by name by a Lambda or an agent, so the names are a
    // contract; and a sixth write, or a write to a sibling's name, would change platform behaviour the
    // caller never asked for. The whole set of commands is compared, not just its members.
    ssmSend.mockResolvedValue({});
    const change = {
      tier1Enabled: false,
      autoResolveThreshold: 0.9,
      commentRequirement: "required",
      agentBackend: "harness",
      agentModelId: "us.anthropic.claude-sonnet-5",
    };

    const res = await put(change);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(change);
    expect(ssmSend).toHaveBeenCalledTimes(5);
    expect(sentCommands()).toEqual(
      [
        { Name: PARAMS.tier1Enabled, Value: "false" },
        { Name: PARAMS.autoResolveThreshold, Value: "0.9" },
        { Name: PARAMS.commentRequirement, Value: "required" },
        { Name: PARAMS.agentBackend, Value: "harness" },
        { Name: PARAMS.agentModelId, Value: "us.anthropic.claude-sonnet-5" },
      ]
        .map((p) => ({ __cmd: "Put", Type: "String", Overwrite: true, ...p }))
        .sort((a, b) => a.Name.localeCompare(b.Name)),
    );
  });

  it('stores a disabled threshold as the literal "off" the agent looks for', async () => {
    ssmSend.mockResolvedValue({});
    const res = await put({ autoResolveThreshold: null });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ autoResolveThreshold: null });
    expect(sentCommands()).toEqual([
      {
        __cmd: "Put",
        Name: PARAMS.autoResolveThreshold,
        Value: "off",
        Type: "String",
        Overwrite: true,
      },
    ]);
  });

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

import { NextResponse } from "next/server";
import { requireReconAdmin } from "@/lib/reconAdmin";
import { AGENT_MODEL_IDS } from "@/lib/server/agentModels";
import { readParam, writeParam } from "@/lib/server/ssm";

// Same-origin BFF for platform config, backed by SSM parameters read at runtime:
//   tier1Enabled          — deterministic Tier-1 route on/off (Tier-1 Lambda reads per batch)
//   autoResolveThreshold  — evidence-completeness threshold for straight-through processing
//                           (the agent reads it after each proposal); null = disabled ("off").
//   agentModelId          — which Bedrock model the Tier-2 agent invokes, read per invocation by
//                           BOTH backends; null = no selection, each uses its deployed default.
// The recipient allowlist is deliberately NOT here. `counterparty_email_domains` is a GATE and
// nothing else: it is read by the gateway interceptor, which re-derives the verdict on every send,
// and by no one else. Publishing it let three other places form an opinion about it -- an amber
// warning on a saved contact, a rejection on the draft PUT, and a banner on the Config tab -- none of
// which was the boundary, all of which read a container env var fixed at task start, and one of which
// read as "the save was blocked" when the save had in fact succeeded.
//
// PUT is admin-only; GET is not, and that asymmetry is deliberate. The case screen reads this to know
// whether a comment is required before approving, so gating the read would break the analyst's day
// job to protect values that say nothing an analyst cannot already observe by using the product. The sibling `/config/contacts` and `/config/templates` reads ARE
// gated, because those return addresses and message bodies.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const TIER1_PARAM =
  process.env.TIER1_ENABLED_PARAM ?? "/recon-dev/tier1-enabled";
const AUTO_RESOLVE_PARAM =
  process.env.AUTO_RESOLVE_PARAM ?? "/recon-dev/auto-resolve-threshold";
const COMMENT_REQ_PARAM =
  process.env.COMMENT_REQUIREMENT_PARAM ?? "/recon-dev/comment-requirement";
const AGENT_BACKEND_PARAM =
  process.env.AGENT_BACKEND_PARAM ?? "/recon-dev/agent-backend";
const AGENT_MODEL_PARAM =
  process.env.AGENT_MODEL_PARAM ?? "/recon-dev/agent-model-id";
const COMMENT_MODES = ["required", "optional", "disapprove-only"] as const;
const AGENT_BACKENDS = ["runtime", "harness"] as const;

function parseThreshold(raw: string | null): number | null {
  // Deployment default before the param exists. Must match the seed in
  // infra/modules/foundation/main.tf — 0.85, not 0.95. The score is satisfied/required evidence
  // steps, so both values demand full evidence for any skill with six or fewer required steps;
  // 0.85 is the lower of the two only in that a 7-step skill can clear it at 6/7.
  if (raw === null) return 0.85;
  const v = raw.trim().toLowerCase();
  if (v === "off") return null;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}

export async function GET() {
  try {
    const [tier1Raw, autoRaw, commentRaw, backendRaw, modelRaw] =
      await Promise.all([
        readParam(TIER1_PARAM),
        readParam(AUTO_RESOLVE_PARAM),
        readParam(COMMENT_REQ_PARAM),
        readParam(AGENT_BACKEND_PARAM),
        readParam(AGENT_MODEL_PARAM),
      ]);
    const mode = (commentRaw ?? "disapprove-only").trim().toLowerCase();
    const backend = (backendRaw ?? "runtime").trim().toLowerCase();
    // No default is substituted for the model, unlike every sibling above, because this route does
    // not know what the default IS: it is each backend's deploy-time environment variable, and the
    // two backends could in principle carry different ones. `null` therefore means "no selection
    // recorded — each backend uses whatever it was deployed with", which is a different statement
    // from any concrete id and is the state a fresh environment is in. An unrecognised stored value
    // is also reported as null: the agent will refuse it and fall back, so showing it as the live
    // selection would be a lie the UI tells on the agent's behalf.
    const model = (modelRaw ?? "").trim();
    return NextResponse.json({
      tier1Enabled: (tier1Raw ?? "true").trim().toLowerCase() === "true",
      autoResolveThreshold: parseThreshold(autoRaw),
      commentRequirement: (COMMENT_MODES as readonly string[]).includes(mode)
        ? mode
        : "disapprove-only",
      agentBackend: (AGENT_BACKENDS as readonly string[]).includes(backend)
        ? backend
        : "runtime",
      agentModelId: (AGENT_MODEL_IDS as readonly string[]).includes(model)
        ? model
        : null,
      agentModelIds: AGENT_MODEL_IDS,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `config read failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  // Admin only. Every value written here changes how the platform behaves for everyone — the
  // auto-resolve threshold decides which cases skip a human entirely, and `agentBackend` /
  // `agentModelId` swap the runtime and the model under a live queue.
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;

  const body = (await req.json().catch(() => ({}))) as {
    tier1Enabled?: boolean;
    autoResolveThreshold?: number | null;
    commentRequirement?: string;
    agentBackend?: string;
    agentModelId?: string;
    counterpartyEmailDomains?: unknown;
  };
  // Refused rather than ignored. A UI that round-trips the whole config object would otherwise
  // appear to change who the system may email while the interceptor kept enforcing the deployed
  // list — the worst kind of security control, one that lies about its own configuration.
  if ("counterpartyEmailDomains" in body) {
    return NextResponse.json(
      {
        error:
          "counterpartyEmailDomains is deploy-time configuration (terraform counterparty_email_domains), not runtime config",
      },
      { status: 400 },
    );
  }
  const hasTier1 = typeof body.tier1Enabled === "boolean";
  const hasAuto = "autoResolveThreshold" in body;
  const hasComment = typeof body.commentRequirement === "string";
  const hasBackend = typeof body.agentBackend === "string";
  const hasModel = typeof body.agentModelId === "string";
  if (!hasTier1 && !hasAuto && !hasComment && !hasBackend && !hasModel) {
    return NextResponse.json(
      {
        error:
          "tier1Enabled, autoResolveThreshold, commentRequirement, agentBackend, or agentModelId required",
      },
      { status: 400 },
    );
  }
  if (
    hasBackend &&
    !(AGENT_BACKENDS as readonly string[]).includes(body.agentBackend!)
  ) {
    return NextResponse.json(
      { error: "agentBackend must be runtime | harness" },
      { status: 400 },
    );
  }
  // Rejected before any write, and the allowlist is named in the error. An id that reached the
  // parameter would be refused per invocation by the agent instead, which surfaces as the model
  // silently not changing rather than as the typo it is.
  if (
    hasModel &&
    !(AGENT_MODEL_IDS as readonly string[]).includes(body.agentModelId!)
  ) {
    return NextResponse.json(
      { error: `agentModelId must be one of: ${AGENT_MODEL_IDS.join(", ")}` },
      { status: 400 },
    );
  }
  if (
    hasComment &&
    !(COMMENT_MODES as readonly string[]).includes(body.commentRequirement!)
  ) {
    return NextResponse.json(
      {
        error:
          "commentRequirement must be required | optional | disapprove-only",
      },
      { status: 400 },
    );
  }
  if (hasAuto) {
    const t = body.autoResolveThreshold;
    if (t !== null && (typeof t !== "number" || t < 0.5 || t > 1)) {
      return NextResponse.json(
        {
          error:
            "autoResolveThreshold must be null (off) or a number in [0.5, 1]",
        },
        { status: 400 },
      );
    }
  }
  try {
    const writes: Promise<unknown>[] = [];
    if (hasTier1) {
      writes.push(
        writeParam(TIER1_PARAM, body.tier1Enabled ? "true" : "false"),
      );
    }
    if (hasAuto) {
      writes.push(
        writeParam(
          AUTO_RESOLVE_PARAM,
          body.autoResolveThreshold === null
            ? "off"
            : String(body.autoResolveThreshold),
        ),
      );
    }
    if (hasComment) {
      writes.push(writeParam(COMMENT_REQ_PARAM, body.commentRequirement!));
    }
    if (hasBackend) {
      writes.push(writeParam(AGENT_BACKEND_PARAM, body.agentBackend!));
    }
    if (hasModel) {
      writes.push(writeParam(AGENT_MODEL_PARAM, body.agentModelId!));
    }
    await Promise.all(writes);
    // The threshold is ENFORCED by AgentCore Policy on the egress gateway, so a non-null
    // change must also rewrite the gated Cedar policies — the SSM value alone is only an
    // app-level hint. Skipped when the policy gate isn't wired (env unset) or auto-resolve is
    // turned off (null); a Policy-update failure surfaces so the admin knows enforcement lags.
    if (
      hasAuto &&
      body.autoResolveThreshold !== null &&
      process.env.EGRESS_GATEWAY_ARN
    ) {
      const { updateConfidenceThreshold } = await import("@/lib/reconPolicy");
      const {
        BedrockAgentCoreControlClient,
        ListPolicyEnginesCommand,
        ListPoliciesCommand,
        UpdatePolicyCommand,
      } = await import("@aws-sdk/client-bedrock-agentcore-control");
      const client = new BedrockAgentCoreControlClient({ region: REGION });
      await updateConfidenceThreshold(
        body.autoResolveThreshold!,
        {
          listPolicyEngines: () =>
            client.send(new ListPolicyEnginesCommand({})),
          listPolicies: (engineId: string) =>
            client.send(new ListPoliciesCommand({ policyEngineId: engineId })),
          updatePolicy: async (
            engineId: string,
            policyId: string,
            statement: string,
          ) => {
            await client.send(
              new UpdatePolicyCommand({
                policyEngineId: engineId,
                policyId,
                definition: { cedar: { statement } },
              }),
            );
          },
        },
        {
          engineName: process.env.POLICY_ENGINE_NAME ?? "",
          gatewayArn: process.env.EGRESS_GATEWAY_ARN ?? "",
        },
      );
    }
    return NextResponse.json({
      ...(hasTier1 ? { tier1Enabled: body.tier1Enabled } : {}),
      ...(hasAuto ? { autoResolveThreshold: body.autoResolveThreshold } : {}),
      ...(hasComment ? { commentRequirement: body.commentRequirement } : {}),
      ...(hasBackend ? { agentBackend: body.agentBackend } : {}),
      ...(hasModel ? { agentModelId: body.agentModelId } : {}),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

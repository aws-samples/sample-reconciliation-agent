import { NextResponse } from "next/server";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
} from "@aws-sdk/client-ssm";
import { requireReconAdmin } from "@/lib/reconAdmin";

// Same-origin BFF for platform config, backed by SSM parameters read at runtime:
//   tier1Enabled          — deterministic Tier-1 route on/off (Tier-1 Lambda reads per batch)
//   autoResolveThreshold  — evidence-completeness threshold for straight-through processing
//                           (the agent reads it after each proposal); null = disabled ("off").
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
const COMMENT_MODES = ["required", "optional", "disapprove-only"] as const;
const AGENT_BACKENDS = ["runtime", "harness"] as const;

function ssm() {
  return new SSMClient({ region: REGION });
}

async function readParam(name: string): Promise<string | null> {
  try {
    const got = await ssm().send(new GetParameterCommand({ Name: name }));
    return got.Parameter?.Value ?? null;
  } catch (err) {
    if ((err as { name?: string }).name === "ParameterNotFound") return null;
    throw err;
  }
}

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
    const [tier1Raw, autoRaw, commentRaw, backendRaw] = await Promise.all([
      readParam(TIER1_PARAM),
      readParam(AUTO_RESOLVE_PARAM),
      readParam(COMMENT_REQ_PARAM),
      readParam(AGENT_BACKEND_PARAM),
    ]);
    const mode = (commentRaw ?? "disapprove-only").trim().toLowerCase();
    const backend = (backendRaw ?? "runtime").trim().toLowerCase();
    return NextResponse.json({
      tier1Enabled: (tier1Raw ?? "true").trim().toLowerCase() === "true",
      autoResolveThreshold: parseThreshold(autoRaw),
      commentRequirement: (COMMENT_MODES as readonly string[]).includes(mode)
        ? mode
        : "disapprove-only",
      agentBackend: (AGENT_BACKENDS as readonly string[]).includes(backend)
        ? backend
        : "runtime",
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
  // auto-resolve threshold decides which cases skip a human entirely, and `agentBackend` swaps the
  // model runtime under a live queue.
  const who = await requireReconAdmin(req);
  if ("error" in who) return who.error;

  const body = (await req.json().catch(() => ({}))) as {
    tier1Enabled?: boolean;
    autoResolveThreshold?: number | null;
    commentRequirement?: string;
    agentBackend?: string;
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
  if (!hasTier1 && !hasAuto && !hasComment && !hasBackend) {
    return NextResponse.json(
      {
        error:
          "tier1Enabled, autoResolveThreshold, commentRequirement, or agentBackend required",
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
        ssm().send(
          new PutParameterCommand({
            Name: TIER1_PARAM,
            Value: body.tier1Enabled ? "true" : "false",
            Type: "String",
            Overwrite: true,
          }),
        ),
      );
    }
    if (hasAuto) {
      writes.push(
        ssm().send(
          new PutParameterCommand({
            Name: AUTO_RESOLVE_PARAM,
            Value:
              body.autoResolveThreshold === null
                ? "off"
                : String(body.autoResolveThreshold),
            Type: "String",
            Overwrite: true,
          }),
        ),
      );
    }
    if (hasComment) {
      writes.push(
        ssm().send(
          new PutParameterCommand({
            Name: COMMENT_REQ_PARAM,
            Value: body.commentRequirement!,
            Type: "String",
            Overwrite: true,
          }),
        ),
      );
    }
    if (hasBackend) {
      writes.push(
        ssm().send(
          new PutParameterCommand({
            Name: AGENT_BACKEND_PARAM,
            Value: body.agentBackend!,
            Type: "String",
            Overwrite: true,
          }),
        ),
      );
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
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

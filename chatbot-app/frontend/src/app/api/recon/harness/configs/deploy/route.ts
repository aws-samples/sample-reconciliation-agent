import { NextResponse } from "next/server";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { lintPromptPolicy } from "@/lib/promptPolicyLint";

// Deploy (or rollback) a config version. Two writes, in this order:
//   1. the version's system_prompt → s3://<assets>/system-prompt.md (the SHARED core policy both
//      Tier-2 backends read: agent-blueprint/recon-agent/agent.py and the harness worker via
//      backend/recon_core/prompt_source.py)
//   2. the SSM pointer → the version string (model_id / max_iterations overrides for the harness)
//
// Step 1 is what makes "Deploy" mean the same thing on both backends. The pointer alone is read
// ONLY by the harness worker, so moving it without the prompt write changes nothing at all under
// agent-backend = runtime (the default) and changes one backend only under the harness.
//
// Ordering matters: the prompt write is the behavior change, the pointer is the label. If the
// pointer write fails after the prompt write, the deployed prompt is live and the UI still shows
// the previous version as LIVE — visible and re-runnable. The reverse order would show a deployed
// version whose text is not in effect, which is the failure mode worth avoiding.
//
// The harness's calling contract (system-prompt-harness.md) is NOT touched here — it is appended
// at invoke time and is not part of a version document.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const CORE_PROMPT_KEY = process.env.SYSTEM_PROMPT_KEY ?? "system-prompt.md";
const POINTER_PARAM =
  process.env.HARNESS_CONFIG_VERSION_PARAM ??
  `/${process.env.NAME_PREFIX ?? "recon-dev"}/harness-config-version`;

function ssm() {
  return new SSMClient({ region: REGION });
}
function s3() {
  return new S3Client({ region: REGION });
}

export async function POST(req: Request) {
  try {
    const { version, acknowledgeWarnings } = (await req.json()) as {
      version?: string;
      acknowledgeWarnings?: boolean;
    };
    if (!version || !version.startsWith("v")) {
      return NextResponse.json(
        { error: "version is required (e.g. v0003)" },
        { status: 400 },
      );
    }

    // Read the version document and fail loudly if it carries no prompt: silently deploying the
    // pointer alone is the inert-deploy bug this route exists to prevent.
    const client = s3();
    const doc = await client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: `harness-configs/${version}.json`,
      }),
    );
    const cfg = JSON.parse((await doc.Body?.transformToString()) ?? "{}") as {
      system_prompt?: string;
    };
    if (!cfg.system_prompt?.trim()) {
      return NextResponse.json(
        { error: `Config ${version} has no system_prompt — nothing to deploy` },
        { status: 409 },
      );
    }

    // A version built from an optimizer recommendation carries that recommendation's injected
    // confirmation policy (the optimizer adds one on every run — see @/lib/promptPolicyLint).
    // Deploying it would make BOTH backends wait for an approval that never arrives, so the
    // caller has to have seen the specific conflicts and said so.
    const warnings = lintPromptPolicy(cfg.system_prompt);
    if (warnings.length > 0 && !acknowledgeWarnings) {
      return NextResponse.json(
        {
          error: `Config ${version} contradicts this platform's autonomy model — review the prompt or re-deploy with acknowledgeWarnings`,
          policyWarnings: warnings,
        },
        { status: 409 },
      );
    }

    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: CORE_PROMPT_KEY,
        Body: cfg.system_prompt,
        ContentType: "text/markdown",
      }),
    );
    await ssm().send(
      new PutParameterCommand({
        Name: POINTER_PARAM,
        Value: version,
        Type: "String",
        Overwrite: true,
      }),
    );
    // promptKey lets the UI state which artifact changed — both backends now run this text.
    return NextResponse.json({ deployed: version, promptKey: CORE_PROMPT_KEY });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
  GetHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";

// Read the live AgentCore Harness config (Config tab → Tier-2 backend section, Harness view).
// Surfaces status, model, iteration cap, tool names, and skill sources.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const HARNESS_NAME =
  process.env.HARNESS_NAME ??
  `${(process.env.NAME_PREFIX ?? "recon-dev").replace(/-/g, "_")}_harness`;

function client() {
  return new BedrockAgentCoreControlClient({ region: REGION });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function modelId(model: any): string {
  return (
    model?.bedrockModelConfig?.modelId ??
    model?.openAiModelConfig?.modelId ??
    model?.liteLlmModelConfig?.modelId ??
    "—"
  );
}

export async function GET() {
  try {
    const c = client();
    const listed = await c.send(new ListHarnessesCommand({}));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = ((listed as any).harnesses ??
      (listed as any).items ??
      []) as any[];
    const match = list.find(
      (h) => h.harnessName === HARNESS_NAME || h.name === HARNESS_NAME,
    );
    if (!match?.harnessId) {
      return NextResponse.json({ configured: false, name: HARNESS_NAME });
    }
    const got = await c.send(
      new GetHarnessCommand({ harnessId: match.harnessId }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (got as any).harness ?? {};
    return NextResponse.json({
      configured: true,
      name: h.harnessName ?? HARNESS_NAME,
      status: h.status ?? "—",
      model: modelId(h.model),
      maxIterations: h.maxIterations ?? null,
      allowedTools: h.allowedTools ?? [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skills: (h.skills ?? [])
        .map((s: any) => s?.s3?.uri ?? s?.path ?? "skill")
        .filter(Boolean),
      version: h.harnessVersion ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

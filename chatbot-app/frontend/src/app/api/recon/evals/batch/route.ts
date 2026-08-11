import { NextResponse } from "next/server";
import {
  BedrockAgentCoreClient,
  StartBatchEvaluationCommand,
  GetBatchEvaluationCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { evalDataSource } from "@/lib/evalDataSource";

// POST → start a batch evaluation; GET ?id=<id> → poll status + results.
//
// The data source is resolved per the ACTIVE agent backend (SSM selector) — a fixed
// harness-only service name silently scored zero sessions while the runtime backend ran.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
// The UI sends the friendly alias "analyst_agreement"; StartBatchEvaluation needs the real
// evaluator id (name + service-generated suffix, e.g. recon_dev_analyst_agreement-xkDl…),
// which only terraform knows — wired via env.
const AGREEMENT_EVALUATOR_ID = process.env.ANALYST_AGREEMENT_EVALUATOR_ID ?? "";

/** Map the UI's friendly evaluator aliases to real evaluator ids; drop unresolvable ones. */
function resolveEvaluatorIds(ids: string[]): string[] {
  return ids
    .map((id) => (id === "analyst_agreement" ? AGREEMENT_EVALUATOR_ID : id))
    .filter((id) => id !== "");
}

function client() {
  return new BedrockAgentCoreClient({ region: REGION });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { name, evaluatorIds, sessionIds, backend } = body as {
      name?: string;
      evaluatorIds?: string[];
      sessionIds?: string[];
      backend?: string;
    };
    if (!evaluatorIds?.length) {
      return NextResponse.json(
        { error: "evaluatorIds required" },
        { status: 400 },
      );
    }

    const ds = await evalDataSource(backend);
    // Name pattern is [a-zA-Z][a-zA-Z0-9_]{0,47} — no hyphens; fold any caller-provided
    // name into the allowed charset and keep repeat runs unique with a time suffix.
    const rawName = name ?? `batch_${Date.now() % 100_000_000}`;
    const batchEvaluationName =
      `b_${rawName.replace(/[^a-zA-Z0-9_]/g, "_")}`.slice(0, 48);
    const cmd = new StartBatchEvaluationCommand({
      batchEvaluationName,
      evaluators: resolveEvaluatorIds(evaluatorIds).map((id) => ({
        evaluatorId: id,
      })),
      dataSourceConfig: {
        cloudWatchLogs: {
          logGroupNames: ds.logGroupNames,
          serviceNames: [ds.serviceName],
          ...(sessionIds?.length ? { filterConfig: { sessionIds } } : {}),
        },
      },
    });

    const resp = await client().send(cmd);
    return NextResponse.json({
      batchEvaluationId:
        resp.batchEvaluationId ?? resp.batchEvaluationName ?? "",
      backend: ds.backend,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id query param required" },
      { status: 400 },
    );
  }
  try {
    const resp = await client().send(
      new GetBatchEvaluationCommand({ batchEvaluationId: id }),
    );
    return NextResponse.json({
      status: resp.status,
      evaluationResults: resp.evaluationResults,
      failureReason:
        (resp as unknown as Record<string, unknown>).failureReason ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import {
  BedrockAgentCoreClient,
  StartRecommendationCommand,
  GetRecommendationCommand,
  StartBatchEvaluationCommand,
  GetBatchEvaluationCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { evalDataSource } from "@/lib/evalDataSource";
import { currentSystemPrompt } from "@/lib/agentSystemPrompt";
import { listGatewayTools } from "@/lib/gatewayMcp";
import { lintPromptPolicy } from "@/lib/promptPolicyLint";

const ACCOUNT_ID = process.env.AWS_ACCOUNT_ID ?? "";

// The reward signal for system-prompt optimization: exactly ONE evaluator reference, and
// evaluationConfig is REQUIRED (devguide "recommendations-system-prompt"). It must be an
// evaluator the source batch actually scored (see SOURCE_EVALUATORS) — the optimizer reads that
// score off the batch's results. GoalSuccessRate is the right signal here: a reconciliation
// session has a concrete task to complete, not an open-ended conversation to be helpful in.
// Tool-description recommendations take NO evaluationConfig (they read tool-selection patterns
// straight from the traces), so this applies to the system-prompt branch only.
const SOURCE_EVALUATORS = [
  "Builtin.GoalSuccessRate",
  "Builtin.Helpfulness",
  "Builtin.Correctness",
];
const TARGET_EVALUATOR_ARN = `arn:aws:bedrock-agentcore:::evaluator/${SOURCE_EVALUATORS[0]}`;

// System-prompt optimization needs an agent-trace source that yields identifiable SESSIONS. The raw
// cloudwatchLogs / inline-span sources frequently fail with "No sessions were identified", but a
// completed **batch evaluation** reliably assembles them — and StartRecommendation accepts a
// batchEvaluation source for SYSTEM_PROMPT (only). So we kick a short batch eval over the active
// backend's sessions and use its ARN. Tool-description recommendations do NOT accept the batch
// source (API rejects it) and take cloudwatchLogs.
//
// ⚠️ The batch eval MUST NOT be awaited inside a request. It runs for over a minute and its duration
// scales with the session count, while CloudFront in front of the ECS origin has
// origin_read_timeout = 60s (infra/modules/frontend-ecs/main.tf). Polling it inline returns "recon
// API error 504" to the UI while the origin is still working and the batch has not yet finished —
// CloudFront has simply given up. So the system-prompt flow is split into three short requests the
// CLIENT sequences:
//   1. POST {type}                      → starts the batch, returns batchEvaluationId  (~1s)
//   2. GET  ?batchId=<id>               → one status probe, client polls this          (~1s)
//   3. POST {type, batchEvaluationArn}  → StartRecommendation, returns recommendationId (~1s)
//   4. GET  ?id=<recommendationId>      → existing recommendation poll
// Raising the CloudFront timeout would only move the cliff, not remove it.
async function startBatchForSource(
  c: BedrockAgentCoreClient,
  ds: { serviceName: string; logGroupNames: string[] },
): Promise<string> {
  const started = (await c.send(
    new StartBatchEvaluationCommand({
      batchEvaluationName: `optsrc_${Date.now() % 1_000_000_000}`,
      evaluators: SOURCE_EVALUATORS.map((id) => ({ evaluatorId: id })),
      dataSourceConfig: {
        cloudWatchLogs: {
          logGroupNames: ds.logGroupNames,
          serviceNames: [ds.serviceName],
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any),
  )) as unknown as Record<string, string>;
  if (!started.batchEvaluationId) {
    throw new Error("StartBatchEvaluation returned no batchEvaluationId");
  }
  return started.batchEvaluationId;
}

// Batch-evaluation lifecycle: PENDING → IN_PROGRESS → COMPLETED | COMPLETED_WITH_ERRORS |
// FAILED | STOPPED. Enumerate the RUNNING states rather than the terminal ones: a
// "not IN_PROGRESS ⇒ done" test treats the initial PENDING as terminal and hands a batch that
// has evaluated nothing to StartRecommendation (batchEvaluationArn is populated from creation,
// so there is no second signal to catch it). COMPLETED_WITH_ERRORS is the normal outcome here —
// some sessions in the window always fail to parse — and does yield a usable source.
const BATCH_RUNNING = new Set(["PENDING", "STARTING", "IN_PROGRESS"]);
const BATCH_USABLE = new Set(["COMPLETED", "COMPLETED_WITH_ERRORS"]);

// POST → start a recommendation (optimization) job; GET ?id=<id> → poll for the result.
//
// AgentCore optimization analyzes the backend's OTel traces in CloudWatch and proposes an
// improved system prompt OR improved tool descriptions. It is backend-agnostic (works for the
// runtime AND harness — it only needs traces in aws/spans, per the AWS docs) and requires
// Transaction Search enabled + at least one completed session.
//
// The request shape follows the boto3/JS `start_recommendation` contract EXACTLY: the config is
// a tagged union keyed by type (`systemPromptRecommendationConfig` /
// `toolDescriptionRecommendationConfig`), each carrying the current input to optimize + an
// `agentTraces` source. A flat `{systemPrompt, agentTraces}` shape is rejected by the service,
// which surfaces in the UI as a button that appears to "do nothing".
//
// Every member of both unions is MANDATORY — there is no "just send the traces" mode:
//   SYSTEM_PROMPT     → systemPrompt (text ≤20,000 chars | configurationBundle)
//                     + agentTraces + evaluationConfig (exactly one evaluator = reward signal)
//   TOOL_DESCRIPTION  → toolDescription (toolDescriptionText | configurationBundle)
//                     + agentTraces, and NO evaluationConfig (rejected — tool selection is read
//                       from the traces directly)
// Optimization is backend-agnostic: nothing in the API distinguishes an AgentCore Runtime agent
// from a managed Harness one, only the trace source. So the current configuration has to be
// resolved from wherever THIS backend keeps it (see @/lib/agentSystemPrompt and
// listGatewayTools) — the API will not infer it from the runtime.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";

function client() {
  return new BedrockAgentCoreClient({ region: REGION });
}

type RecType =
  "SYSTEM_PROMPT_RECOMMENDATION" | "TOOL_DESCRIPTION_RECOMMENDATION";

interface ToolDescr {
  toolName: string;
  description: string;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      type,
      startTime,
      endTime,
      currentPrompt,
      tools,
      backend,
      batchEvaluationArn,
    } = body as {
      type: RecType;
      startTime?: string;
      endTime?: string;
      currentPrompt?: string;
      tools?: ToolDescr[];
      backend?: string;
      // Step 3 of the system-prompt flow: the ARN of the batch eval the client already drove to
      // a terminal state. Absent on a system-prompt POST ⇒ this is step 1 (start the batch).
      batchEvaluationArn?: string;
    };
    if (
      type !== "SYSTEM_PROMPT_RECOMMENDATION" &&
      type !== "TOOL_DESCRIPTION_RECOMMENDATION"
    ) {
      return NextResponse.json(
        {
          error:
            "type must be SYSTEM_PROMPT_RECOMMENDATION or TOOL_DESCRIPTION_RECOMMENDATION",
        },
        { status: 400 },
      );
    }

    const start = startTime
      ? new Date(startTime)
      : new Date(Date.now() - 7 * 86400 * 1000);
    const end = endTime ? new Date(endTime) : new Date();

    // Resolve the active backend's OTel service name + spans log group (same helper the batch
    // route uses) so optimization analyzes the traces of whichever backend actually ran.
    const ds = await evalDataSource(backend);
    const spansGroup =
      ds.logGroupNames.find((g) => g.includes("aws/spans")) ??
      ds.logGroupNames[0];
    const c = client();

    // Step 1: kick the source batch eval and return at once. The client polls GET ?batchId=,
    // then POSTs back with batchEvaluationArn (step 3) to actually start the recommendation.
    if (type === "SYSTEM_PROMPT_RECOMMENDATION" && !batchEvaluationArn) {
      const batchEvaluationId = await startBatchForSource(c, ds);
      return NextResponse.json({
        phase: "BATCH",
        batchEvaluationId,
        backend: ds.backend,
      });
    }

    // name is REQUIRED and must match [a-zA-Z][a-zA-Z0-9_]* — unique-ish per run.
    const name = `rec_${type === "SYSTEM_PROMPT_RECOMMENDATION" ? "sysprompt" : "tooldesc"}_${Date.now() % 1_000_000_000}`;

    // Both config unions have THREE mandatory members, and the "current configuration to
    // optimize" is one of them — `systemPrompt` / `toolDescription` are documented "Required:
    // Yes". Building them conditionally would mean a caller that sends no prompt gets `1
    // validation error detected: Value at
    // 'recommendationConfig.systemPromptRecommendationConfig.systemPrompt' failed to satisfy
    // constraint: Member must not be null`, and the panel does not always send one. So resolve the
    // current configuration SERVER-side from the same places the backends read it, and fail loudly
    // if it can't be resolved rather than dropping the member.
    let recommendationConfig: Record<string, unknown>;
    let promptSource: string | null = null;
    if (type === "SYSTEM_PROMPT_RECOMMENDATION") {
      // An explicit currentPrompt (e.g. a draft being iterated on in the Config panel) wins;
      // otherwise use what the active backend is actually running.
      const prompt = currentPrompt?.trim()
        ? { text: currentPrompt.trim(), source: "request" }
        : await currentSystemPrompt(ds.backend);
      promptSource = prompt.source;
      // Step 3: the client-driven batch eval has reached a usable terminal state; feed its ARN.
      recommendationConfig = {
        systemPromptRecommendationConfig: {
          systemPrompt: { text: prompt.text },
          agentTraces: { batchEvaluation: { batchEvaluationArn } },
          evaluationConfig: {
            evaluators: [{ evaluatorArn: TARGET_EVALUATOR_ARN }],
          },
        },
      };
    } else {
      // Tool descriptions: the API rejects the batch source, so use cloudwatchLogs. The
      // log-group ARN needs the REAL account id (a '*' is rejected) — no account id means no
      // usable trace source, so say that instead of sending an empty list.
      const acct = ACCOUNT_ID || (req.headers.get("x-amzn-account") ?? "");
      if (!acct) {
        throw new Error(
          "AWS_ACCOUNT_ID is not configured — cannot build the trace log-group ARN",
        );
      }
      const logGroupArns = [
        `arn:aws:logs:${REGION}:${acct}:log-group:${spansGroup}`,
      ];
      // The descriptions being optimized are the ones the model sees, i.e. the egress gateway's
      // tool schemas — read them live rather than shipping a hardcoded copy that drifts.
      const currentTools = tools?.length
        ? tools
        : (await listGatewayTools()).map((t) => ({
            toolName: t.name,
            description: t.description,
          }));
      recommendationConfig = {
        toolDescriptionRecommendationConfig: {
          toolDescription: {
            toolDescriptionText: {
              tools: currentTools.map((t) => ({
                toolName: t.toolName,
                toolDescription: { text: t.description },
              })),
            },
          },
          agentTraces: {
            cloudwatchLogs: {
              logGroupArns,
              serviceNames: [ds.serviceName],
              startTime: start,
              endTime: end,
            },
          },
        },
      };
    }

    const resp = (await c.send(
      new StartRecommendationCommand({
        name,
        type,
        recommendationConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    )) as unknown as Record<string, string>;
    return NextResponse.json({
      recommendationId: resp.recommendationId ?? "",
      backend: ds.backend,
      name,
      // Which prompt is being optimized (e.g. "harness:config:v0007"). Surfaced so the UI can
      // say what the recommendation is a diff *against* — a recommendation applied on top of a
      // different prompt than it was derived from is meaningless.
      promptSource,
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
  const batchId = searchParams.get("batchId");

  // Step 2: one probe of the source batch eval. Deliberately side-effect-free — the client, not
  // this handler, decides when to move on to StartRecommendation, so a client that gives up
  // mid-poll cannot leave a half-started recommendation job behind.
  if (batchId) {
    try {
      const b = (await client().send(
        new GetBatchEvaluationCommand({ batchEvaluationId: batchId }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as unknown as Record<string, any>;
      const status = (b.status as string) ?? "UNKNOWN";
      const running = BATCH_RUNNING.has(status);
      return NextResponse.json({
        status,
        running,
        // Only surface the ARN once the batch is actually usable as a trace source. It exists
        // from creation, so returning it while running would invite a premature step 3.
        batchEvaluationArn: BATCH_USABLE.has(status)
          ? ((b.batchEvaluationArn as string) ?? null)
          : null,
      });
    } catch (err) {
      return NextResponse.json(
        { error: (err as Error).message },
        { status: 500 },
      );
    }
  }

  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json(
      { error: "id or batchId query param required" },
      { status: 400 },
    );
  }
  try {
    const resp = (await client().send(
      new GetRecommendationCommand({ recommendationId: id }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    )) as unknown as Record<string, any>;

    // Result lives under recommendationResult.{systemPrompt|toolDescription}RecommendationResult.
    const result = resp.recommendationResult ?? {};
    const sys = result.systemPromptRecommendationResult ?? null;
    const tool = result.toolDescriptionRecommendationResult ?? null;

    return NextResponse.json({
      status: resp.status ?? "UNKNOWN",
      type: resp.type ?? null,
      recommendedSystemPrompt: sys?.recommendedSystemPrompt ?? null,
      systemPromptExplanation: sys?.explanation ?? null,
      // The optimizer's safety pass injects a confirmation policy into every system-prompt
      // recommendation, whatever the baseline said (see @/lib/promptPolicyLint). Surface the
      // conflicts with the panel so nobody applies an approval rule the platform never honours.
      policyWarnings: lintPromptPolicy(sys?.recommendedSystemPrompt ?? ""),
      recommendedTools: tool?.tools ?? null, // [{toolName, recommendedToolDescription, explanation}]
      errorCode: sys?.errorCode ?? tool?.errorCode ?? resp.errorCode ?? null,
      errorMessage:
        sys?.errorMessage ?? tool?.errorMessage ?? resp.errorMessage ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

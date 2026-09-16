import {
  CloudWatchLogsClient,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  BedrockAgentCoreClient,
  StartBatchEvaluationCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { evalDataSource } from "@/lib/evalDataSource";

// Decision-triggered analyst-agreement re-score.
//
// Online evaluation scores a session ONCE, ~5 min after it closes — before any analyst
// decision exists — so the agreement evaluator abstains. When an analyst approves/corrects,
// this kicks a targeted AgentCore Batch Evaluation of the case's LATEST session with ONLY
// the agreement evaluator (the LLM-judge scores don't change with a decision, so re-paying
// for them is waste). The metric on the Evals tab updates a few minutes later.
//
// Best-effort by design: called detached from the decision route (the frontend is a
// long-lived ECS task, so detached promises complete); failures are logged, never surfaced —
// a decision must not fail because a re-score couldn't start.

const REGION = process.env.AWS_REGION ?? "us-east-1";
const SPANS_LOG_GROUP = process.env.HARNESS_LOG_GROUP ?? "aws/spans";
const AGREEMENT_EVALUATOR_ID = process.env.ANALYST_AGREEMENT_EVALUATOR_ID ?? "";

/** Sanitize an item id the way session ids are built from it (AgentCore forbids dots). */
function sanitize(itemId: string): string {
  return itemId.replace(/[^a-zA-Z0-9_-]/g, "-");
}

/** Latest session id for the case (Logs Insights over aws/spans, 14-day window). */
async function latestSessionId(itemId: string): Promise<string | null> {
  const logs = new CloudWatchLogsClient({ region: REGION });
  const end = Math.floor(Date.now() / 1000);
  const prefix = `recon-${sanitize(itemId)}-`;
  const start = await logs.send(
    new StartQueryCommand({
      logGroupNames: [SPANS_LOG_GROUP],
      startTime: end - 14 * 86400,
      endTime: end,
      queryString: `fields attributes.session.id as sid, @timestamp
        | filter strcontains(sid, "${prefix}")
        | sort @timestamp desc
        | limit 1`,
    }),
  );
  const queryId = start.queryId;
  if (!queryId) return null;

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const poll = await logs.send(new GetQueryResultsCommand({ queryId }));
    const status = poll.status ?? "Running";
    if (status === "Complete") {
      const row = poll.results?.[0];
      const sid = row?.find((f) => f.field === "sid")?.value;
      return sid ?? null;
    }
    if (status !== "Running" && status !== "Scheduled") return null;
  }
  return null;
}

/**
 * Kick a targeted agreement re-score for the case's latest session. Fire-and-forget:
 * call as `void rescoreAgreement(itemId)`.
 *
 * :param itemId: raw case item id (e.g. "idp-Notice.pdf").
 */
export async function rescoreAgreement(itemId: string): Promise<void> {
  try {
    if (!AGREEMENT_EVALUATOR_ID) {
      console.warn(
        "[rescore] ANALYST_AGREEMENT_EVALUATOR_ID not wired; skipping",
      );
      return;
    }
    const sessionId = await latestSessionId(itemId);
    if (!sessionId) {
      console.warn(`[rescore] no session found for ${itemId}; skipping`);
      return;
    }
    const ds = await evalDataSource();
    const resp = await new BedrockAgentCoreClient({ region: REGION }).send(
      new StartBatchEvaluationCommand({
        // Name pattern is [a-zA-Z][a-zA-Z0-9_]{0,47} — NO hyphens, and a hyphen is a
        // ValidationException, not a silent trim. Underscore-fold the item id and keep within 48 chars.
        batchEvaluationName: `agree_${sanitize(itemId)
          .replace(/-/g, "_")
          .slice(0, 34)}_${Date.now() % 1_000_000}`,
        evaluators: [{ evaluatorId: AGREEMENT_EVALUATOR_ID }],
        dataSourceConfig: {
          cloudWatchLogs: {
            logGroupNames: ds.logGroupNames,
            serviceNames: [ds.serviceName],
            filterConfig: { sessionIds: [sessionId] },
          },
        },
      }),
    );
    console.log(
      `[rescore] started batch ${resp.batchEvaluationId ?? "?"} for ${itemId} session ${sessionId}`,
    );
  } catch (err) {
    console.warn(`[rescore] failed for ${itemId}: ${(err as Error).message}`);
  }
}

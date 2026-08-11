import { NextResponse } from "next/server";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// GET → the LATEST evaluation run for this case (drill-down on the case detail screen).
//
// Evaluation results live in the service-generated per-config log groups (discovered by
// prefix, same as /api/recon/evals/results). Sessions are matched by the deterministic id
// prefix `recon-<sanitized(item_id)>-` — cases don't store their session ids. Of all scored
// sessions for the case, only the newest one's records are returned.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RESULTS_PREFIX =
  process.env.EVAL_RESULTS_LOG_GROUP_PREFIX ??
  `/aws/bedrock-agentcore/evaluations/results/${(
    process.env.NAME_PREFIX ?? "recon-dev"
  ).replace(/-/g, "_")}_online_eval`;
// Batch evaluations (decision-triggered re-scores + the Evals-tab sweep) write to their own
// service-managed group, separate from the per-config online groups — both must be queried
// or a re-score would never supersede the original online ABSTAIN here.
const BATCH_RESULTS_PREFIX =
  "/aws/bedrock-agentcore/evaluations/batch-evaluations/results";

/** All eval-results log groups (online per-config + batch), discovered by prefix. */
async function resultsLogGroups(logs: CloudWatchLogsClient): Promise<string[]> {
  const names: string[] = [];
  for (const prefix of [RESULTS_PREFIX, BATCH_RESULTS_PREFIX]) {
    const groups = await logs.send(
      new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }),
    );
    for (const g of groups.logGroups ?? []) {
      if (g.logGroupName) names.push(g.logGroupName);
    }
  }
  return names;
}

interface EvalRow {
  sessionId: string;
  evaluator: string;
  value: string | null;
  label: string | null;
  explanation: string | null;
  error: string | null;
  timestamp: string;
}

interface EvalRecord {
  evaluator: string;
  value: string | null;
  label: string | null;
  explanation: string | null;
  error: string | null;
  timestamp: string;
}

const QUERY_FIELDS = `fields @timestamp,
    attributes.session.id as sessionId,
    attributes.gen_ai.evaluation.name as evaluator,
    attributes.gen_ai.evaluation.score.value as value,
    attributes.gen_ai.evaluation.score.label as label,
    attributes.gen_ai.evaluation.explanation as explanation,
    attributes.error.type as error`;

/**
 * Run one Logs Insights query against a SINGLE log group and return the parsed rows.
 *
 * Per-group on purpose: online eval records are EMF-shaped (top-level `_aws`) while batch
 * records are plain JSON, and a single query spanning both heterogeneous schemas silently
 * fails to resolve the aliased dotted fields for one of them (returns rows with all-null
 * columns). Querying each group alone sidesteps that; the caller merges.
 */
async function queryGroup(
  logs: CloudWatchLogsClient,
  logGroupName: string,
  prefix: string,
  startTime: number,
  endTime: number,
): Promise<EvalRow[]> {
  const startResp = await logs.send(
    new StartQueryCommand({
      logGroupName,
      startTime,
      endTime,
      queryString: `${QUERY_FIELDS}
        | filter strcontains(sessionId, "${prefix}")
        | sort @timestamp desc
        | limit 60`,
    }),
  );
  const queryId = startResp.queryId;
  if (!queryId) return [];

  let status = "Running";
  let rows: EvalRow[] = [];
  for (
    let i = 0;
    i < 20 && (status === "Running" || status === "Scheduled");
    i++
  ) {
    await new Promise((r) => setTimeout(r, 500));
    const poll = await logs.send(new GetQueryResultsCommand({ queryId }));
    status = poll.status ?? "Complete";
    if (status === "Complete") {
      rows = (poll.results ?? []).map((row) => {
        const f = Object.fromEntries(
          row.map((field) => [field.field ?? "", field.value ?? ""]),
        );
        return {
          sessionId: f.sessionId ?? "",
          evaluator: f.evaluator ?? "",
          value: f.value || null,
          label: f.label || null,
          explanation: f.explanation || null,
          error: f.error || null,
          timestamp: f["@timestamp"] ?? "",
        };
      });
    }
  }
  if (status !== "Complete") {
    throw new Error(`Logs Insights query ended in status ${status}`);
  }
  return rows;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // Same sanitization session ids are built with (AgentCore forbids dots etc.).
  const prefix = `recon-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-`;

  try {
    const logs = new CloudWatchLogsClient({ region: REGION });

    const logGroupNames = await resultsLogGroups(logs);
    if (logGroupNames.length === 0) {
      return NextResponse.json({ session: null, records: [] });
    }

    const end = Math.floor(Date.now() / 1000);
    const start = end - 14 * 86400;

    // Query each group separately (see queryGroup note) and pool the rows.
    const perGroup = await Promise.all(
      logGroupNames.map((g) => queryGroup(logs, g, prefix, start, end)),
    );
    const allRows = perGroup.flat().filter((r) => r.sessionId && r.evaluator);
    if (allRows.length === 0) {
      return NextResponse.json({ session: null, records: [] });
    }

    // Latest evaluated session = the one holding the newest row across all groups.
    allRows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const latestSession = allRows[0].sessionId;

    // Newest record per evaluator within that session (a re-score in the batch group
    // supersedes the original online-eval record for the same evaluator).
    const byEvaluator = new Map<string, EvalRecord>();
    for (const row of allRows) {
      if (row.sessionId !== latestSession) continue;
      const existing = byEvaluator.get(row.evaluator);
      if (existing && existing.timestamp >= row.timestamp) continue;
      byEvaluator.set(row.evaluator, {
        evaluator: row.evaluator,
        value: row.value,
        label: row.label,
        explanation: row.explanation,
        error: row.error,
        timestamp: row.timestamp,
      });
    }

    return NextResponse.json({
      session: latestSession,
      records: [...byEvaluator.values()],
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

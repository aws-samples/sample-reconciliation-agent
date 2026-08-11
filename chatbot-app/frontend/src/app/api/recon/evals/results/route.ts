import { NextResponse } from "next/server";
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  StartQueryCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-cloudwatch-logs";

// GET → recent evaluation results from the per-config results log groups (Logs Insights).
//
// The evaluations service writes each online eval config's per-session records to a log
// group it names itself (/aws/bedrock-agentcore/evaluations/results/<configName>-<suffix>),
// one per backend config — output_config is not settable on the config resource. The groups
// are therefore discovered by name prefix at request time instead of pinned via env.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
// Matches the terraform config names: <name_prefix with "_">_online_eval_<backend>-<suffix>.
const RESULTS_PREFIX =
  process.env.EVAL_RESULTS_LOG_GROUP_PREFIX ??
  `/aws/bedrock-agentcore/evaluations/results/${(
    process.env.NAME_PREFIX ?? "recon-dev"
  ).replace(/-/g, "_")}_online_eval`;

function logs() {
  return new CloudWatchLogsClient({ region: REGION });
}

/**
 * Query ONE log group for recent eval-result rows. Per-group on purpose: online eval records
 * are EMF-shaped (top-level `_aws`) and batch records are plain JSON; a single Logs Insights
 * query spanning both heterogeneous schemas silently resolves the aliased dotted fields to
 * null for one group, so we query each separately and merge.
 */
async function queryGroup(
  client: CloudWatchLogsClient,
  logGroupName: string,
  startTime: number,
  endTime: number,
  limit: number,
): Promise<Array<Record<string, string>>> {
  const startResp = await client.send(
    new StartQueryCommand({
      logGroupName,
      startTime,
      endTime,
      queryString: `fields @timestamp,
          attributes.session.id as sessionId,
          attributes.gen_ai.evaluation.name as evaluator,
          attributes.gen_ai.evaluation.score.value as value,
          attributes.gen_ai.evaluation.score.label as label,
          attributes.gen_ai.evaluation.explanation as explanation,
          attributes.error.type as error
        | sort @timestamp desc
        | limit ${limit}`,
    }),
  );
  const queryId = startResp.queryId;
  if (!queryId) return [];

  let status = "Running";
  let results: Array<Record<string, string>> = [];
  for (
    let i = 0;
    i < 20 && (status === "Running" || status === "Scheduled");
    i++
  ) {
    await new Promise((r) => setTimeout(r, 500));
    const poll = await client.send(new GetQueryResultsCommand({ queryId }));
    status = poll.status ?? "Complete";
    if (status === "Complete") {
      results = (poll.results ?? []).map((row) =>
        Object.fromEntries(
          row.map((field) => [field.field ?? "", field.value ?? ""]),
        ),
      );
    }
  }
  if (status !== "Complete") {
    throw new Error(`Logs Insights query ended in status ${status}`);
  }
  return results;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 200);

  try {
    const client = logs();

    // Discover the per-backend online results groups AND the batch-evaluations group —
    // decision-triggered re-scores land in the latter and must show here too.
    const logGroupNames: string[] = [];
    for (const prefix of [
      RESULTS_PREFIX,
      "/aws/bedrock-agentcore/evaluations/batch-evaluations/results",
    ]) {
      const groups = await client.send(
        new DescribeLogGroupsCommand({ logGroupNamePrefix: prefix }),
      );
      for (const g of groups.logGroups ?? []) {
        if (g.logGroupName) logGroupNames.push(g.logGroupName);
      }
    }

    if (logGroupNames.length === 0) {
      // No eval config has written results yet — empty, not an error.
      return NextResponse.json({ results: [] });
    }

    const end = Math.floor(Date.now() / 1000);
    const start = end - 7 * 86400; // last 7 days

    // Query each group separately (see queryGroup note), pool, re-sort newest-first, cap.
    const perGroup = await Promise.all(
      logGroupNames.map((g) => queryGroup(client, g, start, end, limit)),
    );
    const results = perGroup
      .flat()
      .sort((a, b) =>
        (b["@timestamp"] ?? "").localeCompare(a["@timestamp"] ?? ""),
      )
      .slice(0, limit);

    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

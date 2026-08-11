import { NextResponse } from "next/server";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";

// GET ?days=7 → per-evaluator daily average + sample count from the Bedrock-AgentCore/Evaluations
// namespace. The frontend renders a line chart + stat tiles from this data.
//
// Metric layout (verified live 2026-07-28): the evaluation service publishes ONE METRIC PER
// EVALUATOR — the metric NAME is the evaluator name (e.g. "Builtin.Helpfulness",
// "recon_dev_analyst_agreement") — dimensioned by service.name (per agent backend), plus
// finer-grained sets that add onlineEvaluationConfigId and/or label. There is NO
// "EvaluationScore" metric with an "EvaluatorId" dimension (the original query matched
// nothing, leaving the panel permanently on its empty state). SEARCH expressions target the
// {service.name}-only dimension set and return one series per backend, which we merge with a
// count-weighted average.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const NAMESPACE = "Bedrock-AgentCore/Evaluations";
// The custom evaluator's metric name is its evaluator NAME: <name_prefix with "_">_analyst_agreement.
// key = stable series key the page renders (labels/empty-state); metric = CloudWatch metric name.
const AGREEMENT_EVALUATOR = `${(process.env.NAME_PREFIX ?? "recon-dev").replace(/-/g, "_")}_analyst_agreement`;
const EVALUATORS: Array<{ key: string; metric: string }> = [
  { key: "analyst_agreement", metric: AGREEMENT_EVALUATOR },
  { key: "Builtin.GoalSuccessRate", metric: "Builtin.GoalSuccessRate" },
  { key: "Builtin.Helpfulness", metric: "Builtin.Helpfulness" },
  { key: "Builtin.Correctness", metric: "Builtin.Correctness" },
];

function cw() {
  return new CloudWatchClient({ region: REGION });
}

/** SEARCH expression matching the per-backend series ({service.name} dimension set only). */
function search(metricName: string, stat: "Average" | "SampleCount"): string {
  return `SEARCH('{${NAMESPACE},"service.name"} MetricName="${metricName}"', '${stat}', 86400)`;
}

/** Index a metric series as timestamp(day) -> value. */
function byDay(r: MetricDataResult): Map<string, number> {
  const m = new Map<string, number>();
  (r.Timestamps ?? []).forEach((t, i) => {
    const v = r.Values?.[i];
    if (v !== undefined) m.set(t.toISOString().slice(0, 10), v);
  });
  return m;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const days = Math.min(parseInt(searchParams.get("days") ?? "7", 10) || 7, 30);
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400 * 1000);

  try {
    const queries = EVALUATORS.flatMap(({ metric }, idx) => [
      {
        Id: `avg_${idx}`,
        Expression: search(metric, "Average"),
        Period: 86400,
      },
      {
        Id: `cnt_${idx}`,
        Expression: search(metric, "SampleCount"),
        Period: 86400,
      },
    ]);

    const resp = await cw().send(
      new GetMetricDataCommand({
        MetricDataQueries: queries,
        StartTime: start,
        EndTime: end,
      }),
    );
    const results = resp.MetricDataResults ?? [];

    // Reshape into { evaluatorId: { timestamps, averages, counts } }. A SEARCH query returns
    // one result PER MATCHED SERIES (all sharing the query Id, distinguished by Label — the
    // label carries the service.name), so per evaluator we merge the per-backend series into
    // one daily series using a count-weighted average.
    const series: Record<
      string,
      { timestamps: string[]; averages: number[]; counts: number[] }
    > = {};
    for (let idx = 0; idx < EVALUATORS.length; idx++) {
      // SEARCH labels embed the stat ("<dims> <metric> Average" / "... SampleCount") —
      // strip it so the Average and SampleCount series for the same backend pair up.
      const seriesKey = (label: string | undefined): string =>
        (label ?? "").replace(/ (Average|SampleCount)$/, "");
      const avgByLabel = new Map(
        results
          .filter((r) => r.Id === `avg_${idx}`)
          .map((r) => [seriesKey(r.Label), byDay(r)]),
      );
      const cntByLabel = new Map(
        results
          .filter((r) => r.Id === `cnt_${idx}`)
          .map((r) => [seriesKey(r.Label), byDay(r)]),
      );

      // Weighted merge across backends per day: avg = Σ(avg_b × count_b) / Σ(count_b).
      const weighted = new Map<string, { sum: number; count: number }>();
      for (const [label, avgs] of avgByLabel) {
        const counts = cntByLabel.get(label);
        for (const [day, avg] of avgs) {
          const count = counts?.get(day) ?? 1;
          const acc = weighted.get(day) ?? { sum: 0, count: 0 };
          acc.sum += avg * count;
          acc.count += count;
          weighted.set(day, acc);
        }
      }

      const daysSorted = [...weighted.keys()].sort();
      series[EVALUATORS[idx].key] = {
        timestamps: daysSorted,
        averages: daysSorted.map((d) => {
          const { sum, count } = weighted.get(d)!;
          return count > 0 ? sum / count : 0;
        }),
        counts: daysSorted.map((d) => weighted.get(d)!.count),
      };
    }

    return NextResponse.json({ days, series });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

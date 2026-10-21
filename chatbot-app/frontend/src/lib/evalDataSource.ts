import { readParam } from "@/lib/server/ssm";

// Server-side helper: resolve the ACTIVE agent backend's evaluation data source.
//
// Batch evaluations and decision-triggered re-scores must query the sessions of whichever
// backend actually ran them. The backend selector lives in SSM (the Config tab writes it);
// the per-backend OTel service names and event-record log groups are terraform-wired JSON
// maps (BACKEND_SERVICE_NAMES / BACKEND_EVENT_LOG_GROUPS). The spans log group (aws/spans)
// plus the backend's runtime log group together give the eval service both signals it needs
// (spans + gen-ai event records) — same layout as the online eval configs.

const SPANS_LOG_GROUP = process.env.HARNESS_LOG_GROUP ?? "aws/spans";
const BACKEND_PARAM = process.env.AGENT_BACKEND_PARAM ?? "";

function parseMap(env: string | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(env ?? "{}");
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

const SERVICE_NAMES = parseMap(process.env.BACKEND_SERVICE_NAMES);
const EVENT_LOG_GROUPS = parseMap(process.env.BACKEND_EVENT_LOG_GROUPS);

// The backend selector changes rarely; cache the SSM read briefly.
let _backend: { value: string; at: number } | null = null;

/** Resolve the active agent backend id ("harness" | "runtime") from SSM, 30 s cache. */
export async function activeBackend(): Promise<string> {
  if (_backend && Date.now() - _backend.at < 30_000) return _backend.value;
  let value = "runtime";
  // Every failure, not only an absent parameter, leaves the default standing: an evaluation must not
  // fail because the selector could not be read.
  try {
    if (BACKEND_PARAM) {
      const v = ((await readParam(BACKEND_PARAM)) ?? "").trim().toLowerCase();
      if (v === "harness" || v === "runtime") value = v;
    }
  } catch {
    /* default stands */
  }
  _backend = { value, at: Date.now() };
  return value;
}

export interface EvalDataSource {
  backend: string;
  serviceName: string;
  logGroupNames: string[];
}

/**
 * Data source for evaluating the given backend's sessions (defaults to the active backend).
 * Throws when the backend's service name isn't wired: a silent fallback would point the batch at
 * a service name nothing emits under, and it would score zero sessions while reporting success.
 */
export async function evalDataSource(
  backend?: string,
): Promise<EvalDataSource> {
  const b = backend ?? (await activeBackend());
  const serviceName = SERVICE_NAMES[b];
  if (!serviceName) {
    throw new Error(
      `No OTel service name wired for backend "${b}" (BACKEND_SERVICE_NAMES env)`,
    );
  }
  const eventLogGroup = EVENT_LOG_GROUPS[b];
  return {
    backend: b,
    serviceName,
    logGroupNames: eventLogGroup
      ? [SPANS_LOG_GROUP, eventLogGroup]
      : [SPANS_LOG_GROUP],
  };
}

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

// Server-side helper: resolve the system prompt the ACTIVE agent backend is really running.
//
// StartRecommendation(SYSTEM_PROMPT_RECOMMENDATION) requires the current prompt as its input
// (`systemPromptRecommendationConfig.systemPrompt.text` — "Required: Yes" in the devguide); the
// service optimizes *that* text against the target evaluator. Omitting it fails with
// "Value at '...systemPrompt' failed to satisfy constraint: Member must not be null".
//
// Both backends now read the SAME policy object — s3://<assets>/system-prompt.md — so there is one
// prompt to optimize regardless of which backend produced the traces
// (agent-blueprint/recon-agent/agent.py:184 and backend/harness_agent/worker.py, via
// backend/recon_core/prompt_source.py). What differs is only the harness's appended calling
// contract (system-prompt-harness.md: submit_proposal fields, prefixed tool names).
//
// That contract is deliberately EXCLUDED from the text sent to the optimizer. An applied
// recommendation is written back to the core object, and the optimizer rewrites what it is given —
// including the contract would let it paraphrase the submit_proposal field list into the shared
// core, which breaks the harness and pollutes the runtime.
//
// Deliberately NO fallback to a stub/empty prompt: a blank or wrong prompt here yields a
// confident recommendation derived from nothing, which is worse than a visible error.

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "";
// The shared policy object both backends read (backend/recon_core/prompt_source.CORE_PROMPT_KEY).
const CORE_PROMPT_KEY = process.env.SYSTEM_PROMPT_KEY ?? "system-prompt.md";
const CONFIG_VERSION_PARAM =
  process.env.HARNESS_CONFIG_VERSION_PARAM ??
  `/${process.env.NAME_PREFIX ?? "recon-dev"}/harness-config-version`;

// The API caps systemPrompt.text at 20,000 characters. The core policy object is ~2.5 KB, so
// hitting this means something unexpected got written to S3 — say so here rather than letting the
// service answer with a generic constraint violation.
const MAX_PROMPT_CHARS = 20_000;

/** Read an S3 text object. Throws with bucket/key context — callers must not paper over this. */
async function readS3Text(bucket: string, key: string): Promise<string> {
  const got = await new S3Client({ region: REGION }).send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return (await got.Body?.transformToString()) ?? "";
}

/**
 * The deployed config version, or null when no version is pointed at.
 * Mirrors backend/harness_agent/config_store.active_version: only "v…" values are real
 * versions ("none"/"" means "run the blueprint defaults").
 *
 * Purely informational: the prompt itself comes from the shared prompt object, not from the
 * version document, so an unset/unreadable pointer must NOT fail the optimization — it only
 * shortens the provenance label.
 */
async function deployedConfigVersion(): Promise<string | null> {
  if (!CONFIG_VERSION_PARAM) return null;
  try {
    const got = await new SSMClient({ region: REGION }).send(
      new GetParameterCommand({ Name: CONFIG_VERSION_PARAM }),
    );
    const raw = (got.Parameter?.Value ?? "").trim();
    return raw.startsWith("v") ? raw : null;
  } catch {
    return null;
  }
}

export interface CurrentSystemPrompt {
  text: string;
  /** Where it came from, for the UI/logs: "shared:s3:system-prompt.md (deployed v0007)". */
  source: string;
}

/**
 * Resolve the system prompt the given backend is currently running.
 *
 * @param backend - "runtime" or "harness" (as returned by evalDataSource().backend).
 * @returns the prompt text plus a short provenance string.
 * @throws if the backend is unknown, the assets bucket is unwired, the prompt is empty, or it
 *   exceeds the API's 20,000-character limit.
 */
export async function currentSystemPrompt(
  backend: string,
): Promise<CurrentSystemPrompt> {
  if (!ASSETS_BUCKET) {
    throw new Error(
      "ASSETS_BUCKET is not configured — cannot read the current system prompt",
    );
  }

  if (backend !== "runtime" && backend !== "harness") {
    throw new Error(
      `Unknown agent backend "${backend}" — cannot resolve its system prompt`,
    );
  }
  // One object for both backends. The deployed config version is reported alongside it (it no
  // longer holds the live prompt — deploying a version writes its text into this object), so the
  // user can still tell which version's text is currently in the core.
  const text = await readS3Text(ASSETS_BUCKET, CORE_PROMPT_KEY);
  const version = await deployedConfigVersion();
  const source = version
    ? `shared:s3:${CORE_PROMPT_KEY} (deployed ${version})`
    : `shared:s3:${CORE_PROMPT_KEY}`;

  if (!text.trim()) {
    throw new Error(
      `The ${backend} backend's system prompt is empty (${source}); nothing to optimize`,
    );
  }
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(
      `The ${backend} backend's system prompt is ${text.length} characters (${source}); ` +
        `StartRecommendation accepts at most ${MAX_PROMPT_CHARS}`,
    );
  }
  return { text, source };
}

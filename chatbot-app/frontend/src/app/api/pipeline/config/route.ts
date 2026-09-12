import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { consoleDefaultModelId } from "@/lib/console/settings";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { AGENT_MODEL_IDS, isAllowedModelId } from "@/lib/server/agentModels";
import { env } from "@/lib/pipeline/server/env";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";
import { readParam, writeParam } from "@/lib/server/ssm";

// Runtime configuration: which Bedrock model the parsing agent invokes, held in the SSM parameter
// `AGENT_MODEL_PARAM` and read by the parser Lambda on every run. GET is open (the Config tab
// shows it to everyone); PUT is admin-gated because it swaps the model under the live pipeline.
//
// GET also reports the CONSOLE's default model id (`<CONSOLE_SETTINGS_PREFIX>/defaults/model-id`, see
// `lib/console/types.ts`) so the Config tab can offer "Use console default". Reporting is all it does:
// choosing it is still a PUT of the pipeline's own parameter, and the parser Lambda keeps reading that
// parameter alone, so nothing outside this BFF learns the console default exists.
export const runtime = "nodejs";

/**
 * @returns `{ modelId, modelIds, consoleDefaultModelId }`; `modelId` is null when the parameter is
 *   absent or not allowlisted; `consoleDefaultModelId` is the console-wide default or null when none
 *   is set, reported raw (the UI compares it against `modelIds` and can say when it is not offered).
 */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    const value = (await readParam(env.agentModelParam()))?.trim() ?? null;
    return NextResponse.json({
      modelId: value && isAllowedModelId(value) ? value : null,
      modelIds: AGENT_MODEL_IDS,
      consoleDefaultModelId: await consoleDefaultModelId(),
    });
  } catch (err) {
    return jsonError(500, `config read failed: ${(err as Error).message}`);
  }
}

/** Set the model: body `{ modelId }` from the allowlist. */
export async function PUT(req: Request) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const body = await readJsonObject(req);
  const modelId = body ? stringField(body, "modelId") : undefined;
  if (!modelId || !isAllowedModelId(modelId)) {
    return jsonError(400, `modelId must be one of: ${AGENT_MODEL_IDS.join(", ")}`);
  }
  try {
    await writeParam(env.agentModelParam(), modelId);
    return NextResponse.json({ modelId });
  } catch (err) {
    return jsonError(500, `config write failed: ${(err as Error).message}`);
  }
}

import { NextResponse } from "next/server";
import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";

import { requireActor } from "@/lib/api-auth";
import { requirePipelineAdmin } from "@/lib/pipelineAdmin";
import { AGENT_MODEL_IDS, isAllowedModelId } from "@/lib/pipeline/server/agentModels";
import { ssm } from "@/lib/pipeline/server/aws";
import { env } from "@/lib/pipeline/server/env";
import { jsonError, readJsonObject, stringField } from "@/lib/pipeline/server/http";

// Runtime configuration: which Bedrock model the parsing agent invokes, held in the SSM parameter
// `AGENT_MODEL_PARAM` and read by the parser Lambda on every run. GET is open (the Config tab
// shows it to everyone); PUT is admin-gated because it swaps the model under the live pipeline.
export const runtime = "nodejs";

/** @returns `{ modelId, modelIds }`; `modelId` is null when the parameter is absent or not allowlisted. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    let value: string | null = null;
    try {
      const got = await ssm().send(new GetParameterCommand({ Name: env.agentModelParam() }));
      value = got.Parameter?.Value?.trim() ?? null;
    } catch (err) {
      if ((err as { name?: string }).name !== "ParameterNotFound") throw err;
    }
    return NextResponse.json({
      modelId: value && isAllowedModelId(value) ? value : null,
      modelIds: AGENT_MODEL_IDS,
    });
  } catch (err) {
    return jsonError(500, `config read failed: ${(err as Error).message}`);
  }
}

/** Set the model: body `{ modelId }` from the allowlist. */
export async function PUT(req: Request) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;
  const body = await readJsonObject(req);
  const modelId = body ? stringField(body, "modelId") : undefined;
  if (!modelId || !isAllowedModelId(modelId)) {
    return jsonError(400, `modelId must be one of: ${AGENT_MODEL_IDS.join(", ")}`);
  }
  try {
    await ssm().send(
      new PutParameterCommand({
        Name: env.agentModelParam(),
        Value: modelId,
        Type: "String",
        Overwrite: true,
      }),
    );
    return NextResponse.json({ modelId });
  } catch (err) {
    return jsonError(500, `config write failed: ${(err as Error).message}`);
  }
}

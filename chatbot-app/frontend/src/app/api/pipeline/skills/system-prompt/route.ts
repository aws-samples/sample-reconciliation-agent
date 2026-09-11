import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requirePipelineAdmin } from "@/lib/pipelineAdmin";
import { env } from "@/lib/pipeline/server/env";
import { jsonError, readJsonObject, stringField } from "@/lib/pipeline/server/http";
import { getParserPrompt, putParserPrompt } from "@/lib/pipeline/server/skillsStore";

// The parsing agent's system prompt (`PARSER_PROMPT_KEY`, default `prompts/parser-system.md`).
// Edited from the Skills tab; the parser reads it on every run.
export const runtime = "nodejs";

/** @returns `{ key, content }`; 404 when the prompt has not been seeded. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const key = env.parserPromptKey();
  try {
    const content = await getParserPrompt();
    if (content === null) return jsonError(404, `parser prompt not found at ${key}`);
    return NextResponse.json({ key, content });
  } catch (err) {
    return jsonError(500, `prompt read failed: ${(err as Error).message}`);
  }
}

/** Replace the prompt: body `{ content }`. Admin-gated — it changes every future parse. */
export async function PUT(req: Request) {
  const admin = await requirePipelineAdmin(req);
  if ("error" in admin) return admin.error;
  const body = await readJsonObject(req);
  const content = body ? stringField(body, "content") : undefined;
  if (!content) return jsonError(400, "content is required");
  try {
    await putParserPrompt(content);
    return NextResponse.json({ key: env.parserPromptKey() });
  } catch (err) {
    return jsonError(500, `prompt write failed: ${(err as Error).message}`);
  }
}

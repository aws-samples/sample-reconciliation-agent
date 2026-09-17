import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { validateSkill } from "@/lib/skillFrontmatter";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";
import {
  deleteSkill,
  getSkill,
  putSkill,
  SKILL_NAME,
} from "@/lib/pipeline/server/skillsStore";

// One skill: read the raw SKILL.md, replace it, or delete it — all against the live
// `skills/<name>/SKILL.md` object the parser loads.
export const runtime = "nodejs";

/** Names are S3 path segments; anything outside the pattern is refused before it forms a key. */
function badName(name: string) {
  return SKILL_NAME.test(name) ? null : jsonError(400, "skill name must match ^[a-z0-9-]+$");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  const { name } = await params;
  const invalid = badName(name);
  if (invalid) return invalid;
  try {
    const content = await getSkill(name);
    if (content === null) return jsonError(404, `skill ${name} not found`);
    return NextResponse.json({ name, content });
  } catch (err) {
    return jsonError(500, `skill read failed: ${(err as Error).message}`);
  }
}

/** Replace a skill's content: body `{ content }`. Admin-gated; frontmatter must validate. */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const { name } = await params;
  const invalid = badName(name);
  if (invalid) return invalid;
  const body = await readJsonObject(req);
  const content = body ? stringField(body, "content") : undefined;
  if (!content) return jsonError(400, "content is required");
  const problem = validateSkill(content, name);
  if (problem) return jsonError(400, problem);
  try {
    await putSkill(name, content);
    return NextResponse.json({ name });
  } catch (err) {
    return jsonError(500, `skill write failed: ${(err as Error).message}`);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const { name } = await params;
  const invalid = badName(name);
  if (invalid) return invalid;
  try {
    await deleteSkill(name);
    return NextResponse.json({ deleted: name });
  } catch (err) {
    return jsonError(500, `skill delete failed: ${(err as Error).message}`);
  }
}

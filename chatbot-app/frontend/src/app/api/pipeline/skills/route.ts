import { NextResponse } from "next/server";

import { requireActor } from "@/lib/api-auth";
import { requireAppAdmin } from "@/lib/auth/app-admin";
import { validateSkill } from "@/lib/skillFrontmatter";
import { jsonError, readJsonObject, stringField } from "@/lib/server/http";
import { isSkillExists } from "@/lib/server/skillsStore";
import { createSkill, listSkills } from "@/lib/pipeline/server/skillsStore";

// The parsing agent's skills catalog: live SKILL.md objects under `skills/<name>/` in the assets
// bucket. GET lists and parses them; PUT creates a new skill. The parser reads the same prefix on
// every run, so a write here applies to the next parse without a redeploy.
export const runtime = "nodejs";

/** @returns the catalog: `{ name, description, tools, model, key }[]`. */
export async function GET(req: Request) {
  const who = await requireActor(req);
  if ("error" in who) return who.error;
  try {
    return NextResponse.json(await listSkills());
  } catch (err) {
    return jsonError(500, `skills list failed: ${(err as Error).message}`);
  }
}

/**
 * Create a skill: body `{ name, content }`.
 *
 * @returns 201 `{ name }`; 400 when the frontmatter does not validate; 409 when the skill exists
 *   (edit it through `/skills/[name]` instead — a create that silently replaces is how a skill the
 *   desk spent a week on disappears).
 */
export async function PUT(req: Request) {
  const admin = await requireAppAdmin("pipeline", req);
  if ("error" in admin) return admin.error;
  const body = await readJsonObject(req);
  const name = body ? stringField(body, "name") : undefined;
  const content = body ? stringField(body, "content") : undefined;
  if (!name || !content) return jsonError(400, "name and content are required");
  const invalid = validateSkill(content, name);
  if (invalid) return jsonError(400, invalid);
  try {
    // The store refuses an existing skill (`createConflicts`); the 409 is this route's wording.
    await createSkill(name, content);
    return NextResponse.json({ name }, { status: 201 });
  } catch (err) {
    if (isSkillExists(err)) {
      return jsonError(
        409,
        `skill ${name} already exists; update it with PUT /api/pipeline/skills/${name}`,
      );
    }
    return jsonError(500, `skill create failed: ${(err as Error).message}`);
  }
}

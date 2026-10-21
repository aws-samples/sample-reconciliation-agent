import { NextResponse } from "next/server";
import { validateSkill } from "@/lib/skillFrontmatter";
import { reconSkillsStore } from "@/lib/reconSkills";

// Same-origin BFF for the skills catalog. Skills are live SKILL.md objects under
// s3://<assets>/skills/ — GET lists+parses them (metadata catalog); PUT creates a new skill.
// The agent reads the same prefix at runtime, so edits apply without a redeploy.
//
// No authorization runs here: the proxy's recon access group is the gate, as it always has been
// (docs/shared-spine-proposal.md §8a, option 1). The S3 calls are the shared store, bound to recon's
// bucket and behaviour in lib/reconSkills.ts.
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await reconSkillsStore().listSkills());
  } catch (err) {
    return NextResponse.json(
      { error: `skills list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

// Create a new skill: body { name, content }. Validates frontmatter before writing. A skill that
// already exists is replaced — the collection PUT is create-or-replace, not create-only.
export async function PUT(req: Request) {
  const { name, content } = (await req.json().catch(() => ({}))) as {
    name?: string;
    content?: string;
  };
  if (!name || !content) {
    return NextResponse.json(
      { error: "name and content required" },
      { status: 400 },
    );
  }
  const invalid = validateSkill(content, name);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  try {
    // directory-per-skill layout (harness-compatible): <prefix><name>/SKILL.md
    await reconSkillsStore().createSkill(name, content);
    return NextResponse.json({ name });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

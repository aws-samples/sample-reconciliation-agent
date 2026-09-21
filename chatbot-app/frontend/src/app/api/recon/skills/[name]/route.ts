import { NextResponse } from "next/server";
import { validateSkill } from "@/lib/skillFrontmatter";
import { isProtectedSkill } from "@/lib/server/skillsStore";
import { reconSkillsStore } from "@/lib/reconSkills";

// Per-skill BFF: read the full raw SKILL.md, update it (PUT), or delete it. All against the
// live s3://<assets>/skills/<name>/SKILL.md object the agent + harness read (directory-per-skill
// layout — the harness requires a dir per skill; the container loader reads any .md recursively).
//
// No authorization runs here: the proxy's recon access group is the gate, as it always has been
// (docs/shared-spine-proposal.md §8a, option 1). The S3 calls are the shared store, bound to recon's
// bucket and behaviour in lib/reconSkills.ts.
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  // Any failure reads as "not found" (recon's `missingAsNotFound: "any-error"`), as it always did.
  const content = await reconSkillsStore().getSkill(name);
  if (content === null) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ name, content });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  const { content } = (await req.json().catch(() => ({}))) as {
    content?: string;
  };
  if (!content)
    return NextResponse.json({ error: "content required" }, { status: 400 });
  const invalid = validateSkill(content, name);
  if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });
  try {
    await reconSkillsStore().putSkill(name, content);
    return NextResponse.json({ name });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    await reconSkillsStore().deleteSkill(name);
    return NextResponse.json({ deleted: name });
  } catch (err) {
    if (isProtectedSkill(err)) {
      // The fallback classification type must always exist — never deletable. Refused by the store
      // before any S3 call.
      return NextResponse.json(
        { error: `the '${name}' fallback skill cannot be deleted` },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

import { NextResponse } from "next/server";
import { reconSkillsStore } from "@/lib/reconSkills";

// Same-origin BFF for the workflow system prompt: a single s3://<assets>/system-prompt.md the
// agent loads to frame the overall reconciliation workflow. Editable in the UI, applied live.
//
// No authorization runs here: the proxy's recon access group is the gate, as it always has been
// (docs/shared-spine-proposal.md §8a, option 1). The S3 calls are the shared store, bound to recon's
// bucket and behaviour in lib/reconSkills.ts.
export const runtime = "nodejs";

export async function GET() {
  // Any failure reads as "not yet set" (recon's `missingAsNotFound: "any-error"`): the editor opens
  // empty and the agent falls back to its built-in framing.
  const content = await reconSkillsStore().getPrompt();
  return NextResponse.json({ content: content ?? "" });
}

export async function PUT(req: Request) {
  const { content } = (await req.json().catch(() => ({}))) as {
    content?: string;
  };
  if (content === undefined) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    // An empty prompt is a legitimate edit (`emptyPromptAllowed: true`).
    await reconSkillsStore().putPrompt(content);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

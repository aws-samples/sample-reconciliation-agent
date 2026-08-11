import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { validateSkill } from "@/lib/skillFrontmatter";

// Per-skill BFF: read the full raw SKILL.md, update it (PUT), or delete it. All against the
// live s3://<assets>/skills/<name>/SKILL.md object the agent + harness read (directory-per-skill
// layout — the harness requires a dir per skill; the container loader reads any .md recursively).
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const PREFIX = process.env.SKILLS_PREFIX ?? "skills/";

function s3() {
  return new S3Client({ region: REGION });
}
function key(name: string) {
  return `${PREFIX}${name}/SKILL.md`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  try {
    const got = await s3().send(
      new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key(name) }),
    );
    const content = (await got.Body?.transformToString()) ?? "";
    return NextResponse.json({ name, content });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
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
    await s3().send(
      new PutObjectCommand({
        Bucket: ASSETS_BUCKET,
        Key: key(name),
        Body: content,
        ContentType: "text/markdown",
      }),
    );
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
  if (name === "unknown") {
    // The fallback classification type must always exist — never deletable.
    return NextResponse.json(
      { error: "the 'unknown' fallback skill cannot be deleted" },
      { status: 400 },
    );
  }
  try {
    await s3().send(
      new DeleteObjectCommand({ Bucket: ASSETS_BUCKET, Key: key(name) }),
    );
    return NextResponse.json({ deleted: name });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

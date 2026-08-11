import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { parseSkill, validateSkill } from "@/lib/skillFrontmatter";

// Same-origin BFF for the skills catalog. Skills are live SKILL.md objects under
// s3://<assets>/skills/ — GET lists+parses them (metadata catalog); PUT creates a new skill.
// The agent reads the same prefix at runtime, so edits apply without a redeploy.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const PREFIX = process.env.SKILLS_PREFIX ?? "skills/";

function s3() {
  return new S3Client({ region: REGION });
}

export async function GET() {
  try {
    const client = s3();
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: ASSETS_BUCKET, Prefix: PREFIX }),
    );
    const catalog = [];
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key?.endsWith(".md")) continue;
      const got = await client.send(
        new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: obj.Key }),
      );
      const { body: _body, ...meta } = parseSkill(
        (await got.Body?.transformToString()) ?? "",
      );
      catalog.push(meta);
    }
    return NextResponse.json(catalog);
  } catch (err) {
    return NextResponse.json(
      { error: `skills list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

// Create a new skill: body { name, content }. Validates frontmatter before writing.
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
    await s3().send(
      new PutObjectCommand({
        Bucket: ASSETS_BUCKET,
        Key: `${PREFIX}${name}/SKILL.md`, // directory-per-skill layout (harness-compatible)
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

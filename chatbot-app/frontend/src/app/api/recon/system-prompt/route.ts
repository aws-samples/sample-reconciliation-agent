import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

// Same-origin BFF for the workflow system prompt: a single s3://<assets>/system-prompt.md the
// agent loads to frame the overall reconciliation workflow. Editable in the UI, applied live.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const KEY = process.env.SYSTEM_PROMPT_KEY ?? "system-prompt.md";

function s3() {
  return new S3Client({ region: REGION });
}

export async function GET() {
  try {
    const got = await s3().send(
      new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: KEY }),
    );
    return NextResponse.json({
      content: (await got.Body?.transformToString()) ?? "",
    });
  } catch {
    return NextResponse.json({ content: "" }); // not yet set → empty
  }
}

export async function PUT(req: Request) {
  const { content } = (await req.json().catch(() => ({}))) as {
    content?: string;
  };
  if (content === undefined) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  try {
    await s3().send(
      new PutObjectCommand({
        Bucket: ASSETS_BUCKET,
        Key: KEY,
        Body: content,
        ContentType: "text/markdown",
      }),
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

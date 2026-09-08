import { NextResponse } from "next/server";
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// Read-only viewer for the Tier-1 deterministic Lambda source. The source files are seeded to
// s3://<assets>/lambda-src/tier1/ at deploy time; this route lists them and returns their raw
// contents. There is intentionally NO write path — the code is viewable, not editable, here.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const PREFIX = process.env.LAMBDA_SRC_PREFIX ?? "lambda-src/tier1/";

function s3() {
  return new S3Client({ region: REGION });
}

// Read-only source viewers, keyed by ?src=: the deterministic Tier-1 Lambda, the Tier-2 container
// agent, or the egress-gateway REQUEST interceptor (the code that refuses a ledger write). All are
// seeded under lambda-src/<name>/ at deploy time — viewable, not editable.
const AGENT_PREFIX = process.env.AGENT_SRC_PREFIX ?? "lambda-src/agent/";
const GUARD_PREFIX = process.env.GUARD_SRC_PREFIX ?? "lambda-src/guard/";

// An unknown ?src= falls back to Tier-1 rather than erroring, matching the pre-existing behaviour
// for every value other than "agent".
const PREFIXES: Record<string, string> = {
  agent: AGENT_PREFIX,
  guard: GUARD_PREFIX,
};

// GET /api/recon/lambda-src[?src=agent|guard] -> [{ path, content }] for the seeded source files
export async function GET(req: Request) {
  const src = new URL(req.url).searchParams.get("src");
  const prefix = (src && PREFIXES[src]) ?? PREFIX;
  try {
    const client = s3();
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: ASSETS_BUCKET, Prefix: prefix }),
    );
    const files = [];
    for (const obj of listed.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      const got = await client.send(
        new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: obj.Key }),
      );
      files.push({
        path: obj.Key.slice(prefix.length),
        content: (await got.Body?.transformToString()) ?? "",
      });
    }
    // Stable order so the viewer's file list doesn't jump around.
    files.sort((a, b) => a.path.localeCompare(b.path));
    return NextResponse.json(files);
  } catch (err) {
    return NextResponse.json(
      { error: `lambda source read failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

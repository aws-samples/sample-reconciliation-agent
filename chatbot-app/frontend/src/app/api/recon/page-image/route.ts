import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Streams a document page preview image from RECON's assets bucket (copied there by the IDP
// hook at ingest). Same-origin, so the <img> tags need no presigned URLs or IDP access.
// The key is prefix-locked to idp-pages/ to prevent arbitrary bucket reads.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ASSETS_BUCKET = process.env.ASSETS_BUCKET ?? "recon-dev-assets";
const ALLOWED_PREFIX = "idp-pages/";

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key.startsWith(ALLOWED_PREFIX) || key.includes("..")) {
    return new Response("invalid key", { status: 400 });
  }
  try {
    const got = await new S3Client({ region: REGION }).send(
      new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: key }),
    );
    const bytes = await got.Body?.transformToByteArray();
    if (!bytes) return new Response("not found", { status: 404 });
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": got.ContentType ?? "image/jpeg",
        // Page images are immutable once copied — cache aggressively.
        "Cache-Control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

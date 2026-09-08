import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { idpGraphQL } from "@/lib/idpAppSync";
import { extensionOf } from "@/lib/uploadPolicy";

// The source file behind one processed document, streamed from the extraction pipeline's input bucket
// so the Documents tab can show it beside what was extracted from it.
//
// Two things make this safe to expose without a presigned URL. First, the key is not trusted: it is
// resolved through the pipeline's own `getDocument` before a single byte is read, so this route can
// only ever serve an object the pipeline has a record of -- a caller who invents a key gets a 404 and
// not somebody else's object. Second, `src/proxy.ts` gates `/api/recon/*`, so an unauthenticated
// request never reaches this file. That gate is also why the browser cannot point an `<iframe src>`
// straight at this route: `SourceDocumentPreview` does the object-URL fetch that carries the token.
//
// Object keys contain `/`, so the caller encodes the whole key into this ONE dynamic segment, and the
// param must NOT be decoded again -- Next.js has already decoded it, and a second pass mangles a key
// carrying a literal `%`. Both conventions match the sibling detail route.
export const runtime = "nodejs";

/** Confirms the key exists upstream. Deliberately the smallest possible selection set. */
const EXISTS_QUERY = `
  query ReconDocumentExists($key: ID!) {
    getDocument(ObjectKey: $key) {
      ObjectKey
    }
  }
`;

/**
 * Content types that mean "S3 does not know what this is" rather than naming a real format.
 *
 * ⚠️ `binary/octet-stream` is the one that matters, and it is easy to miss because it is not the
 * spelling anyone writes by hand. S3 stamps it on any object uploaded without an explicit
 * `ContentType`, which is every document the extraction pipeline ingests. So `ContentType` is
 * almost never absent -- it is present and useless, and a `??` fallback never fires on it.
 *
 * The effect was that every PDF in the pipeline rendered as a download button instead of in the
 * frame, on a route that already had the extension table needed to type it correctly.
 */
const UNKNOWN_TYPES = new Set([
  "binary/octet-stream",
  "application/octet-stream",
  "application/unknown",
  "",
]);

/**
 * What to render an object as when S3 has not usefully typed it.
 *
 * Only the types a browser can display are listed. Anything else falls through to a download, which is
 * the honest outcome: an `.xlsx` handed to an `<iframe>` renders as a blank frame, and a blank frame
 * reads as a broken preview rather than as a file the browser cannot show.
 */
const VIEWABLE_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".txt": "text/plain",
};

/**
 * Read the source object for one processed document.
 *
 * @param _req - the request; unused, present for the route signature.
 * @param ctx - route context carrying the already-decoded `objectKey` segment.
 * @returns 200 with the object's bytes; 400 for a key this route will not look up; 404 when the
 *   pipeline has no such document or the object is gone from the bucket; 500 when the deployment has
 *   no input bucket configured; 502 when the pipeline's API refuses or is unreachable.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ objectKey: string }> },
) {
  const { objectKey } = await ctx.params;

  // Rejected before the upstream call rather than relied on afterwards. `..` and a leading `/` are not
  // reachable through the resolve step below, but a key that cannot be legitimate should be refused by
  // the check that names the reason, not by whichever downstream call happens to fail first.
  if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/")) {
    return new Response("invalid object key", { status: 400 });
  }

  const bucket = process.env.IDP_INPUT_BUCKET;
  if (!bucket) {
    // Loud, because the alternative is a 404 that an operator reads as "the pipeline lost my file".
    return new Response(
      "IDP_INPUT_BUCKET is not set, so no source document can be read",
      { status: 500 },
    );
  }

  try {
    const found = await idpGraphQL<{
      getDocument: { ObjectKey: string } | null;
    }>({ query: EXISTS_QUERY, variables: { key: objectKey } });
    if (!found.getDocument) {
      return new Response(`no document found for object key ${objectKey}`, {
        status: 404,
      });
    }
  } catch (err) {
    return new Response(
      `could not confirm the document: ${(err as Error).message}`,
      { status: 502 },
    );
  }

  try {
    const got = await new S3Client({}).send(
      new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
    );
    const bytes = await got.Body?.transformToByteArray();
    if (!bytes)
      return new Response("source document is empty", { status: 404 });
    // S3's own type wins only when it actually says something. Otherwise the key's extension does --
    // see UNKNOWN_TYPES for why `??` alone was not enough.
    const stored = (got.ContentType ?? "").trim().toLowerCase();
    const contentType = UNKNOWN_TYPES.has(stored)
      ? (VIEWABLE_TYPES[extensionOf(objectKey)] ?? "application/octet-stream")
      : stored;
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": contentType,
        // `inline` so a PDF renders in the frame instead of downloading. The name is the key's tail,
        // which is what the operator uploaded and what the table's Document column already shows.
        "Content-Disposition": `inline; filename="${objectKey.split("/").pop() ?? "document"}"`,
        // Private, and short. The bytes are customer financial documents, so no shared cache may hold
        // them; the window is long enough that toggling the panel open and shut does not re-fetch.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    // The pipeline had a record and the bucket does not: the object was expired or deleted after
    // processing. A 404 saying which key, rather than a 502, because nothing here is broken.
    //
    // ⚠️ `AccessDenied` is treated as the same outcome, and that is not laziness. S3 answers a
    // GetObject for an absent key with `AccessDenied` -- not `NoSuchKey` -- unless the caller also
    // holds `s3:ListBucket`, so that a bucket's key namespace cannot be probed by reading the error.
    // The task role does hold ListBucket on this bucket (see the frontend-ecs task policy) precisely
    // so the honest `NoSuchKey` comes back, but mapping AccessDenied here too means the tab degrades
    // to "the object is gone" instead of pasting a raw IAM denial into the operator's face if that
    // grant is ever dropped. The verbatim message is still returned on the header for diagnosis.
    const name = (err as { name?: string }).name ?? "";
    if (
      name === "NoSuchKey" ||
      name === "NotFound" ||
      name === "AccessDenied"
    ) {
      return new Response(
        `the pipeline has a record for ${objectKey} but the object is no longer in the input bucket`,
        {
          status: 404,
          headers: {
            "X-Source-Read-Error": `${name}: ${(err as Error).message}`.slice(
              0,
              400,
            ),
          },
        },
      );
    }
    return new Response(
      `source document read failed: ${(err as Error).message}`,
      { status: 502 },
    );
  }
}

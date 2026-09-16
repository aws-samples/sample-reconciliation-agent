import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { UnknownDocumentError } from "@/lib/noticeExtraction";
import { readDocumentSourceRef } from "@/lib/idpDocumentStore";
import { extensionOf } from "@/lib/uploadPolicy";

// The source file behind one ingested document, streamed from the extraction pipeline's input bucket so
// the Documents tab can show it beside what was extracted from it.
//
// Two things make this safe to expose without a presigned URL. First, the key is not trusted and is not
// even USED as a key: the param only looks up recon's own notice row, and the object read is issued
// against the `source_document` that row recorded. So the bytes served are the ones recon itself
// ingested, and a caller who invents a key gets a 404 rather than an arbitrary object out of the bucket
// -- a stronger guarantee than the pipeline merely confirming it had a record for the key it was handed.
// Second, `src/proxy.ts` gates `/api/recon/*`, so an unauthenticated request never reaches this file.
// That gate is also why the browser cannot point an `<iframe src>` straight at this route:
// `SourceDocumentPreview` does the object-URL fetch that carries the token.
//
// Object keys contain `/`, so the caller encodes the whole key into this ONE dynamic segment, and the
// param must NOT be decoded again -- Next.js has already decoded it, and a second pass mangles a key
// carrying a literal `%`. Both conventions match the sibling detail route.
export const runtime = "nodejs";

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
 * @returns 200 with the object's bytes; 400 for a key this route will not look up; 404 when recon has no
 *   row for the key, the row was not ingested from a document, or the object is gone from the bucket;
 *   500 when the deployment has no input bucket configured or the notices table cannot be read; 502 when
 *   the bucket read fails for any other reason.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ objectKey: string }> },
) {
  const { objectKey } = await ctx.params;

  // Rejected before anything is read rather than relied on afterwards. `..` and a leading `/` cannot
  // reach S3 through the resolve step below, but a key that cannot be legitimate should be refused by
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

  // The probe, and the only place the S3 key comes from.
  let key: string;
  try {
    const ref = await readDocumentSourceRef({ objectKey });

    // ⚠️ Gated on `parse_method` and deliberately NOT on `record_kind`. A tracking-only row
    // (`record_kind == "document"`) carries `parse_method: "IDP"` precisely so that a document which
    // FAILED before producing a notice still has its source PDF viewable -- which is exactly the
    // moment an operator needs to look at it. Refusing those rows would hide the file whenever it
    // mattered most.
    //
    // The gate is forward-defence rather than a fix for anything on screen today: the notices table is
    // never seeded (see `infra/modules/notice-store/main.tf`), so every row in it right now came from a
    // real document. It exists for the structured-feed adapter, whose rows will have no source file at
    // all, and it says so instead of letting them 404 out of S3 with a message about a missing object.
    if (ref.parseMethod !== "IDP") {
      return new Response(
        `this notice was not ingested from a document, so there is no source file (${objectKey})`,
        { status: 404 },
      );
    }
    if (!ref.sourceDocument) {
      return new Response(
        `recon's row for ${objectKey} records no source document, so there are no bytes to read`,
        { status: 404 },
      );
    }
    key = ref.sourceDocument;
  } catch (err) {
    if (err instanceof UnknownDocumentError) {
      return new Response(`no document found for object key ${objectKey}`, {
        status: 404,
      });
    }
    // 500: the notices table is recon's own, so a failure to read it is a fault in this deployment and
    // not something to send the operator upstream about.
    return new Response(
      `could not confirm the document: ${(err as Error).message}`,
      { status: 500 },
    );
  }

  try {
    const got = await new S3Client({}).send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    const bytes = await got.Body?.transformToByteArray();
    if (!bytes)
      return new Response("source document is empty", { status: 404 });
    // S3's own type wins only when it actually says something. Otherwise the extension does -- see
    // UNKNOWN_TYPES for why `??` alone was not enough. Of the RESOLVED key, because that is the object
    // whose bytes these are.
    const stored = (got.ContentType ?? "").trim().toLowerCase();
    const contentType = UNKNOWN_TYPES.has(stored)
      ? (VIEWABLE_TYPES[extensionOf(key)] ?? "application/octet-stream")
      : stored;
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": contentType,
        // `inline` so a PDF renders in the frame instead of downloading. The name is the key's tail,
        // which is what the operator uploaded and what the table's Document column already shows.
        "Content-Disposition": `inline; filename="${key.split("/").pop() ?? "document"}"`,
        // Private, and short. The bytes are customer financial documents, so no shared cache may hold
        // them; the window is long enough that toggling the panel open and shut does not re-fetch.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (err) {
    // Recon had a row and the bucket does not: the object was expired or deleted after processing. A 404
    // saying which key, rather than a 502, because nothing here is broken.
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
        `recon has a row for ${objectKey} but the object is no longer in the input bucket`,
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

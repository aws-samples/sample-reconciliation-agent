import { NextResponse } from "next/server";
import { UnknownDocumentError } from "@/lib/noticeExtraction";
import { readDocumentRow, toIdpDocumentDetail } from "@/lib/idpDocumentStore";

// One ingested document in full: its header fields plus its sections with the per-attribute confidence
// alerts behind the alert count.
//
// Read from recon's own notice row rather than from the extraction pipeline's GraphQL API — see
// `src/lib/idpDocumentStore.ts`, which owns both the read and the translation from the stored
// snake_case attributes to the PascalCase contract this route has always answered with.
//
// Object keys contain `/`, so the caller encodes the whole key and it arrives in this ONE dynamic
// segment. A catch-all (`[...objectKey]`) would arrive split into an array and rejoining it guesses at
// the original separators.
//
// Do NOT decodeURIComponent the param. Next.js has already decoded it. Decoding twice mangles a key
// containing a literal `%` — and keys taken from email attachment filenames routinely carry `%20`-style
// sequences as literal characters, so the common cases survive a double decode and only the awkward
// ones break.
export const runtime = "nodejs";

/**
 * Read one document by object key.
 *
 * @param _req - the request; unused, present for the route signature.
 * @param ctx - route context carrying the already-decoded `objectKey` segment.
 * @returns 200 with `{document}`; 404 when recon has no row for the key; 500 when the notices table
 *   cannot be read.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ objectKey: string }> },
) {
  const { objectKey } = await ctx.params;

  try {
    const row = await readDocumentRow({ objectKey });
    return NextResponse.json({ document: toIdpDocumentDetail(row) });
  } catch (err) {
    // A missing row is a 404 and not an empty success, because a detail panel rendering blank fields for
    // a mistyped key looks like a document that was processed and produced nothing.
    if (err instanceof UnknownDocumentError)
      return NextResponse.json(
        { error: `no document found for object key ${objectKey}` },
        { status: 404 },
      );
    return NextResponse.json(
      { error: `document read failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

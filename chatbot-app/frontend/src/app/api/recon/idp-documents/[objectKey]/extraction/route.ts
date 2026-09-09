import { NextResponse } from "next/server";
import {
  readNoticeExtraction,
  UnknownDocumentError,
} from "@/lib/noticeExtraction";

// What the pipeline read out of one document: every extracted field, with the confidence IDP scored
// it and the threshold that confidence is judged against. This is the half of the Documents tab's
// detail panel that the tracking record cannot answer -- see `src/lib/noticeExtraction.ts` for where
// the values live and why they are read off recon's own notice row rather than fetched back out of
// the pipeline's API.
//
// Object keys contain `/`, so the caller encodes the whole key into this ONE dynamic segment, and the
// param must NOT be decoded again -- Next.js has already decoded it, and a second pass mangles a key
// carrying a literal `%`. Both conventions match the sibling detail and source routes.
export const runtime = "nodejs";

/**
 * Read one document's extraction.
 *
 * @param _req - the request; unused, present for the route signature.
 * @param ctx - route context carrying the already-decoded `objectKey` segment.
 * @returns 200 with `{sections, unavailable}` — `unavailable` names why an existing notice carries no
 *   per-field detail, and is null when it carries some; 400 for a key this route will not look up;
 *   404 when recon has no notice for the document; 502 when the notices table is unreachable.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ objectKey: string }> },
) {
  const { objectKey } = await ctx.params;
  if (!objectKey || objectKey.includes("..") || objectKey.startsWith("/"))
    return NextResponse.json({ error: "invalid object key" }, { status: 400 });

  try {
    // `unavailable` is additive and always present, so a client that ignores it still sees the same
    // `{sections}` it always did -- an empty list, which it already renders as "nothing extracted".
    const { sections, unavailable } = await readNoticeExtraction({ objectKey });
    return NextResponse.json({ sections, unavailable });
  } catch (err) {
    if (err instanceof UnknownDocumentError)
      return NextResponse.json({ error: err.message }, { status: 404 });
    return NextResponse.json(
      { error: `extraction read failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

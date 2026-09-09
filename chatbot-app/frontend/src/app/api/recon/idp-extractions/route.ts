import { NextResponse } from "next/server";
import { readNoticeExtractions } from "@/lib/noticeExtraction";

// Extractions for MANY documents at once, so the Documents tab can offer the extracted fields as
// table columns. The per-document route next door answers the detail panel; this one answers the
// table, and the two share `src/lib/noticeExtraction.ts` so a value in a column and the same value in
// the panel can never be read differently.
//
// A POST rather than a GET with repeated parameters: a hundred object keys carrying `/`, spaces and
// literal `%` do not survive a query string worth reading, and nothing here is cacheable anyway.
//
// It sits OUTSIDE `/api/recon/idp-documents/` deliberately. That path's only child is the
// `[objectKey]` dynamic segment, so a sibling named `extractions` would shadow any document whose key
// began with that word -- Next.js prefers the static segment, and the shadowing would show up as one
// document that cannot be opened rather than as a routing mistake.
//
// A failure for one key is reported against that key instead of failing the request. One document
// recon never wrote a notice for must not cost the operator the ninety-nine that are readable.
export const runtime = "nodejs";

/**
 * Upper bound on keys per request — the same ceiling the list route puts on rows per page.
 *
 * It is also exactly DynamoDB's BatchGetItem limit, so a full page is one round trip. The reader
 * chunks anyway rather than depending on the two numbers staying equal.
 */
const MAX_KEYS = 100;

/**
 * Read one page of extractions.
 *
 * @param req - the request; body `{objectKeys: string[]}`.
 * @returns 200 with `{extractions, failed}` — `extractions` keyed by object key, `failed` carrying the
 *   reason for each key that could not be read; 400 when the body is not a usable key list.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    objectKeys?: unknown;
  };
  const keys = body.objectKeys;
  if (!Array.isArray(keys) || keys.length === 0)
    return NextResponse.json(
      { error: "objectKeys (non-empty array of strings) is required" },
      { status: 400 },
    );
  if (keys.length > MAX_KEYS)
    return NextResponse.json(
      {
        error: `at most ${MAX_KEYS} object keys per request; ${keys.length} were sent`,
      },
      { status: 400 },
    );
  // Every entry checked on its own, and a bad one refused rather than skipped: a caller who sent one
  // unusable key should find out, not receive a result set quietly missing a row.
  const bad = keys.find(
    (k) =>
      typeof k !== "string" ||
      k === "" ||
      k.includes("..") ||
      k.startsWith("/"),
  );
  if (bad !== undefined)
    return NextResponse.json(
      { error: `objectKeys contains an entry this route will not look up` },
      { status: 400 },
    );

  try {
    // The reader already reports per-key failures — no notice row, or a row whose detail was dropped —
    // into `failed`, so the response shape is unchanged from when this fanned out over IDP's API.
    const { extractions, failed } = await readNoticeExtractions({
      objectKeys: keys as string[],
    });
    return NextResponse.json({ extractions, failed });
  } catch (err) {
    // Only a whole-table failure reaches here: a misconfigured table name, or credentials the task
    // role does not have. That is not attributable to any one key, so it fails the request.
    return NextResponse.json(
      { error: `extraction read failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

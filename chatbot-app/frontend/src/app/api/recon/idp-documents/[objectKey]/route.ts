import { NextResponse } from "next/server";
import { idpGraphQL } from "@/lib/idpAppSync";

// One processed document in full: its header fields, its sections with the per-attribute confidence
// alerts behind the alert count, and its pages with their classifications.
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

const DETAIL_QUERY = `
  query ReconGetDocument($key: ID!) {
    getDocument(ObjectKey: $key) {
      ObjectKey
      ObjectStatus
      WorkflowStatus
      WorkflowExecutionArn
      InitialEventTime
      QueuedTime
      CompletionTime
      ConfigVersion
      EvaluationStatus
      HITLStatus
      HITLTriggered
      HITLCompleted
      HITLReviewOwner
      HITLReviewedBy
      HITLReviewURL
      PageCount
      ConfidenceAlertCount
      Sections {
        Id
        Class
        Excluded
        ExclusionReason
        PageIds
        ConfidenceThresholdAlerts {
          attributeName
          confidence
          confidenceThreshold
        }
      }
      Pages {
        Id
        Class
      }
    }
  }
`;

/**
 * Read one document by object key.
 *
 * @param req - the request; unused, present for the route signature.
 * @param ctx - route context carrying the already-decoded `objectKey` segment.
 * @returns 200 with `{document}`; 404 when no document answers to the key; 502 when the upstream API
 *   refuses or is unreachable.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ objectKey: string }> },
) {
  const { objectKey } = await ctx.params;

  try {
    const data = await idpGraphQL<{ getDocument: unknown | null }>({
      query: DETAIL_QUERY,
      variables: { key: objectKey },
    });
    // A null document with no GraphQL error means the key is unknown. That is a 404 and not an empty
    // success, because a detail page rendering blank fields for a mistyped key looks like a document
    // that was processed and produced nothing.
    if (data.getDocument === null || data.getDocument === undefined)
      return NextResponse.json(
        { error: `no document found for object key ${objectKey}` },
        { status: 404 },
      );
    return NextResponse.json({ document: data.getDocument });
  } catch (err) {
    return NextResponse.json(
      { error: `document read failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

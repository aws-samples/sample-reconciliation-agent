import { NextResponse } from "next/server";
import { idpGraphQL } from "@/lib/idpAppSync";

// List documents the pipeline has processed, for the Documents tab.
//
// A read for any authenticated user, which is why it lives here and not under `/api/recon/config/`.
// An analyst needs to see whether the notice they uploaded came out the other side; only an operator
// needs to change what a workflow type pins.
//
// Two things this route deliberately does NOT offer:
//
//  - **A production/test filter.** The upstream query takes no such argument — asking for one is a
//    schema validation error, which that API answers as HTTP 200 with an `errors` array. Forwarding a
//    filter parameter would therefore turn every request into a failure that reads like "no documents".
//    A `view` parameter is refused outright rather than ignored, so a caller written against the older
//    contract finds out immediately instead of trusting a filter that was never applied.
//  - **A count from upstream.** The count query returns null for a machine caller, with no error and no
//    way to tell that null from a real zero. The count here is the number of rows actually returned,
//    which cannot disagree with what is on screen.
export const runtime = "nodejs";

/** Days of history to read when the caller does not give a window. */
const DEFAULT_WINDOW_DAYS = 30;

/** Upper bound on rows per request. The upstream query is paged; an unbounded limit invites a timeout. */
const MAX_LIMIT = 100;

// Every field the tab's table and detail header render. `ProcessingIssueCount` is absent from the
// upstream schema — requesting it would fail the whole query, so the column does not exist here either.
const DOCUMENT_FIELDS = `
  ObjectKey
  ObjectStatus
  WorkflowStatus
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
  PageCount
  ConfidenceAlertCount
`;

const LIST_QUERY = `
  query ReconListDocuments($start: AWSDateTime, $end: AWSDateTime, $limit: Int, $nextToken: String) {
    listDocuments(startDateTime: $start, endDateTime: $end, limit: $limit, nextToken: $nextToken) {
      nextToken
      Documents { ${DOCUMENT_FIELDS} }
    }
  }
`;

/** One row as the tab consumes it. Nullable throughout — the pipeline fills these in as it goes. */
export interface IdpDocumentRow {
  ObjectKey: string | null;
  ObjectStatus: string | null;
  WorkflowStatus: string | null;
  InitialEventTime: string | null;
  QueuedTime: string | null;
  CompletionTime: string | null;
  ConfigVersion: string | null;
  EvaluationStatus: string | null;
  HITLStatus: string | null;
  HITLTriggered: boolean | null;
  HITLCompleted: boolean | null;
  HITLReviewOwner: string | null;
  HITLReviewedBy: string | null;
  PageCount: number | null;
  ConfidenceAlertCount: number | null;
}

/**
 * Read one page of processed documents.
 *
 * @param req - the request; accepts `startDateTime`, `endDateTime` (ISO-8601), `limit`, `nextToken`.
 * @returns 200 with `{documents, nextToken, count, window}`; 400 on a bad parameter; 502 when the
 *   upstream API refuses or is unreachable.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  if (params.has("view"))
    return NextResponse.json(
      {
        error:
          "the document pipeline offers no production/test filter, so `view` cannot be honoured; drop the parameter rather than assuming it filtered",
      },
      { status: 400 },
    );

  // The window is required upstream in spirit — the underlying index is queried over a range — so a
  // missing one is filled in here rather than left to whatever the resolver happens to default to.
  const end = params.get("endDateTime") ?? new Date().toISOString();
  const start =
    params.get("startDateTime") ??
    new Date(
      Date.parse(end) - DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

  if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end)))
    return NextResponse.json(
      { error: "startDateTime and endDateTime must be ISO-8601 timestamps" },
      { status: 400 },
    );
  if (Date.parse(start) > Date.parse(end))
    return NextResponse.json(
      { error: "startDateTime is after endDateTime" },
      { status: 400 },
    );

  const rawLimit = params.get("limit");
  let limit = MAX_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1)
      return NextResponse.json(
        { error: "limit must be a positive integer" },
        { status: 400 },
      );
    limit = Math.min(parsed, MAX_LIMIT);
  }

  try {
    const data = await idpGraphQL<{
      listDocuments: {
        nextToken: string | null;
        Documents: IdpDocumentRow[] | null;
      } | null;
    }>({
      query: LIST_QUERY,
      variables: { start, end, limit, nextToken: params.get("nextToken") },
    });
    const page = data.listDocuments;
    const documents = page?.Documents ?? [];
    return NextResponse.json({
      documents,
      nextToken: page?.nextToken ?? null,
      count: documents.length,
      // Echoed so the tab can state the window it is actually showing rather than the one the operator
      // thinks they asked for.
      window: { startDateTime: start, endDateTime: end },
    });
  } catch (err) {
    // 502, not 500: the failure is upstream, and the tab renders a different message for "the document
    // pipeline would not answer" than for a fault in this app.
    return NextResponse.json(
      { error: `document list failed: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}

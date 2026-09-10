import { NextResponse } from "next/server";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
// Type-only, so it survives the `vi.mock` of this module in the tests: the import is erased.
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  DOCUMENT_INDEX,
  DOCUMENT_INDEX_HASH,
  documentsTable,
  toIdpDocument,
  type DocumentRow,
} from "@/lib/idpDocumentStore";

// List the documents recon ingested, for the Documents tab.
//
// The rows come from recon's OWN notice table, off the `idp-document-index` GSI, which the IDP
// post-processing hook writes at ingest — see `src/lib/idpDocumentStore.ts` for what that row holds and
// why reading it beats signing a query against the extraction pipeline's GraphQL API.
//
// A read for any authenticated user, which is why it lives here and not under `/api/recon/config/`. An
// analyst needs to see whether the notice they uploaded came out the other side; only an operator needs
// to change what a workflow type pins.
//
// One thing this route deliberately does NOT offer: a **production/test filter**. Recon records no such
// flag on a notice, so there is nothing to filter on. A `view` parameter is refused outright rather than
// ignored, so a caller written against the older contract finds out immediately instead of trusting a
// filter that was never applied.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";

/** Days of history to read when the caller does not give a window. */
const DEFAULT_WINDOW_DAYS = 30;

/** Upper bound on rows per request. The query is paged; an unbounded limit invites a timeout. */
const MAX_LIMIT = 100;

/**
 * A DynamoDB `LastEvaluatedKey` as an opaque continuation token.
 *
 * ⚠️ All THREE attributes have to survive the trip. A key on a GSI is the index's own hash and range
 * (`idp_record`, `idp_started_at`) PLUS the table's key (`notice_id`), because the index is not unique;
 * a token that carried only the two index attributes would be rejected, and one that kept only the
 * timestamp would silently re-read whichever row shares it. So the marshalled key is serialised
 * verbatim rather than being picked apart into fields this route names.
 *
 * base64url and not plain base64: the token travels as a query parameter, and `+` in a query string is
 * a space. That is exactly the corruption that pages back to page one forever without ever failing.
 *
 * @param key - the marshalled `LastEvaluatedKey` DynamoDB returned.
 * @returns the token to hand back to the caller.
 */
function encodeToken(key: Record<string, AttributeValue>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * A continuation token back into a `LastEvaluatedKey`.
 *
 * @param token - the `nextToken` query parameter.
 * @returns the marshalled key, or null when the token is not one this route issued.
 */
function decodeToken(token: string): Record<string, AttributeValue> | null {
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    // Each value must itself be an attribute-value wrapper (`{"S": "..."}`). Checking that here means a
    // token from some other paging scheme is a 400 naming the parameter rather than a ValidationException
    // that this route would have to report as its own fault.
    for (const [, value] of entries)
      if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    return parsed as Record<string, AttributeValue>;
  } catch {
    return null;
  }
}

/**
 * Read one page of ingested documents, newest first.
 *
 * @param req - the request; accepts `startDateTime`, `endDateTime` (ISO-8601), `limit`, `nextToken`.
 * @returns 200 with `{documents, nextToken, count, window}`; 400 on a bad parameter; 500 when the
 *   notices table cannot be read.
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;

  if (params.has("view"))
    return NextResponse.json(
      {
        error:
          "recon records no production/test flag on a notice, so `view` cannot be honoured; drop the parameter rather than assuming it filtered",
      },
      { status: 400 },
    );

  // The window is not optional to the query itself — the GSI is read over a range of `idp_started_at` —
  // so a missing one is filled in here rather than left to a scan of the whole index.
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

  const rawToken = params.get("nextToken");
  let startKey: Record<string, AttributeValue> | undefined;
  if (rawToken !== null && rawToken !== "") {
    const decoded = decodeToken(rawToken);
    // A 400 and never a restart from page one. Silently dropping an unreadable token would hand the
    // caller the FIRST page again, which a paging client reads as more results and follows forever.
    if (!decoded)
      return NextResponse.json(
        {
          error:
            "nextToken is not a continuation token this route issued; drop it to start from the newest page",
        },
        { status: 400 },
      );
    startKey = decoded;
  }

  try {
    const resp = await new DynamoDBClient({ region: REGION }).send(
      new QueryCommand({
        TableName: documentsTable(),
        IndexName: DOCUMENT_INDEX,
        // Neither attribute is a DynamoDB reserved word, so both are named inline.
        KeyConditionExpression:
          "idp_record = :r AND idp_started_at BETWEEN :s AND :e",
        ExpressionAttributeValues: {
          ":r": { S: DOCUMENT_INDEX_HASH },
          ":s": { S: start },
          ":e": { S: end },
        },
        // Newest first. The tab's column header claims it, and the range key sorts ascending by default.
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: startKey,
      }),
    );
    const documents = (resp.Items ?? []).map((item) =>
      toIdpDocument(unmarshall(item) as DocumentRow),
    );
    return NextResponse.json({
      documents,
      nextToken: resp.LastEvaluatedKey
        ? encodeToken(resp.LastEvaluatedKey)
        : null,
      count: documents.length,
      // Echoed so the tab can state the window it is actually showing rather than the one the operator
      // thinks they asked for.
      window: { startDateTime: start, endDateTime: end },
    });
  } catch (err) {
    // 500 and not 502: this is recon's own datastore. A 502 would tell the operator to go and ask
    // whoever runs the document pipeline about a failure nobody there can see.
    return NextResponse.json(
      { error: `document list failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

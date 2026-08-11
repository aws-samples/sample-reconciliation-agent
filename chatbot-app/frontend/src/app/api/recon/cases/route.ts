import { NextResponse } from "next/server";
import {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { recordLessonMemoryEvent } from "@/lib/reconMemory";

// Same-origin BFF: list open (non-terminal) reconciliation cases straight from DynamoDB using
// the ECS task role. Avoids cross-origin fetch/CORS + browser JWT to the external API Gateway.
// POST performs a BULK status update (+ optional comment) across selected item_ids.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const CASES_TABLE = process.env.CASES_TABLE ?? "recon-dev-cases";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";
const OPEN_STATUSES = ["PENDING", "IN_PROGRESS", "PROPOSED"];
// Every lifecycle status — the dashboard/history views query across all of them.
const ALL_STATUSES = [
  "PENDING",
  "IN_PROGRESS",
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "RESOLVED",
  "AUTO_CLEARED",
  "CLOSED_NO_ACTION",
  "AGED",
];
// Statuses an operator may set in bulk from the queue (agent-owned states excluded).
const BULK_STATUSES = ["IN_PROGRESS", "CLOSED_NO_ACTION"];

// GET /api/recon/cases                -> open cases (default; the triage queue)
// GET /api/recon/cases?scope=all      -> every case, all statuses (history)
// GET /api/recon/cases?status=RESOLVED-> one status
export async function GET(req: Request) {
  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const scope = url.searchParams.get("scope");
  let statuses = OPEN_STATUSES;
  if (statusParam && ALL_STATUSES.includes(statusParam))
    statuses = [statusParam];
  else if (scope === "all") statuses = ALL_STATUSES;
  try {
    const ddb = new DynamoDBClient({ region: REGION });
    const rows: Record<string, unknown>[] = [];
    for (const status of statuses) {
      const resp = await ddb.send(
        new QueryCommand({
          TableName: CASES_TABLE,
          IndexName: "status-index",
          KeyConditionExpression: "#s = :s",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":s": { S: status } },
        }),
      );
      for (const item of resp.Items ?? []) {
        const row = unmarshall(item);
        // Legacy rows may carry `item` as a JSON string — normalize for the UI.
        if (typeof row.item === "string") {
          try {
            row.item = JSON.parse(row.item);
          } catch {
            /* leave as-is */
          }
        }
        rows.push(row);
      }
    }
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json(
      { error: `cases query failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }
}

// Bulk status update: body { item_ids: string[], status, comment? }. Sets the status on each
// case and stamps the operator's comment (into attributes.user_comment) + a lessons record so
// bulk triage decisions are captured like single-case ones.
export async function POST(req: Request) {
  const { item_ids, status, comment } = (await req
    .json()
    .catch(() => ({}))) as {
    item_ids?: string[];
    status?: string;
    comment?: string;
  };
  if (!Array.isArray(item_ids) || item_ids.length === 0) {
    return NextResponse.json(
      { error: "item_ids (non-empty array) is required" },
      { status: 400 },
    );
  }
  if (!status || !BULK_STATUSES.includes(status)) {
    return NextResponse.json(
      { error: `status must be one of ${BULK_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  // Enforce the configured decision-comment requirement on bulk actions too.
  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const got = await new SSMClient({ region: REGION }).send(
      new GetParameterCommand({
        Name: process.env.COMMENT_REQUIREMENT_PARAM ?? "/recon-dev/comment-requirement",
      }),
    );
    if (
      (got.Parameter?.Value ?? "").trim().toLowerCase() === "required" &&
      !(comment ?? "").trim()
    ) {
      return NextResponse.json(
        { error: "a comment is required by configuration" },
        { status: 400 },
      );
    }
  } catch {
    /* fail-safe: default mode does not require bulk comments */
  }

  const ddb = new DynamoDBClient({ region: REGION });
  const updated: string[] = [];
  const failed: { item_id: string; error: string }[] = [];

  for (const id of item_ids) {
    try {
      // Set status; attach the comment to the nested item's attributes when provided.
      const names: Record<string, string> = { "#s": "status" };
      const values: Record<string, { S: string }> = { ":s": { S: status } };
      let expr = "SET #s = :s";
      if (comment && comment.trim()) {
        // attributes lives under the nested `item` map; use a nested path.
        names["#it"] = "item";
        names["#at"] = "attributes";
        names["#uc"] = "user_comment";
        values[":c"] = { S: comment.trim() };
        expr += ", #it.#at.#uc = :c";
      }
      await ddb.send(
        new UpdateItemCommand({
          TableName: CASES_TABLE,
          Key: { item_id: { S: id } },
          UpdateExpression: expr,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: "attribute_exists(item_id)",
        }),
      );
      updated.push(id);
      // Best-effort lessons capture (bulk manual triage decision).
      try {
        await ddb.send(
          new PutItemCommand({
            TableName: LESSONS_TABLE,
            Item: marshall(
              {
                lesson_id: `${id}#BULK_STATUS`,
                created_at: new Date().toISOString(),
                item_id: id,
                trigger: "BULK_STATUS",
                disposition: status,
                user_comment: comment?.trim() || undefined,
              },
              { removeUndefinedValues: true },
            ),
          }),
        );
      } catch {
        /* lessons capture is best-effort */
      }
      // Feed AgentCore Memory too (lessons_learned strategy) — best-effort.
      await recordLessonMemoryEvent({
        item_id: id,
        trigger: "BULK_STATUS",
        disposition: status,
        user_comment: comment?.trim() || undefined,
      });
    } catch (err) {
      failed.push({ item_id: id, error: (err as Error).message });
    }
  }

  return NextResponse.json({ updated, failed });
}

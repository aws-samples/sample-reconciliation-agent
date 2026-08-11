import { NextResponse } from "next/server";
import { DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

// Same-origin BFF: list lessons-learned from the recon-lessons ledger for the UI tab.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";

export async function GET(req: Request) {
  const domain = new URL(req.url).searchParams.get("domain");
  try {
    const ddb = new DynamoDBClient({ region: REGION });
    const resp = domain
      ? await ddb.send(
          new QueryCommand({
            TableName: LESSONS_TABLE,
            IndexName: "domain-index",
            KeyConditionExpression: "#d = :d",
            ExpressionAttributeNames: { "#d": "domain" },
            ExpressionAttributeValues: { ":d": { S: domain } },
            ScanIndexForward: false,
          }),
        )
      : await ddb.send(new ScanCommand({ TableName: LESSONS_TABLE }));
    return NextResponse.json((resp.Items ?? []).map((i) => unmarshall(i)));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

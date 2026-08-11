import { NextResponse } from "next/server";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

// Same-origin BFF: read the agent's CONSOLIDATED LONG-TERM MEMORY directly from AgentCore
// Memory (distinct from the DynamoDB recon-lessons ledger that /api/recon/lessons serves).
// The `lessons_learned` SEMANTIC strategy extracts + consolidates analyst decisions into
// retrievable records under namespace reconciliation/lessons/{domain}; this route enumerates
// the recon domains (from the lessons ledger) and retrieves those records for the Lessons tab.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RECON_MEMORY_ID = process.env.RECON_MEMORY_ID ?? "";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";
// Mirrors backend recon_core.lessons_recall: the actorId segment of the lessons namespace.
const DEFAULT_DOMAIN = "lending";
// Consolidated lessons per domain — a generous top_k so the tab shows the full recalled set.
const TOP_K = 25;

interface MemoryRecord {
  id: string;
  domain: string;
  namespace: string;
  content: string;
  createdAt: string;
}

// Scan the lessons ledger for the distinct `domain` values that back the memory namespaces.
// Falls back to a single default domain when the ledger is empty (fresh deployments).
async function listDomains(ddb: DynamoDBClient): Promise<string[]> {
  const resp = await ddb.send(new ScanCommand({ TableName: LESSONS_TABLE }));
  const domains = new Set<string>();
  for (const item of resp.Items ?? []) {
    const row = unmarshall(item) as { domain?: string };
    if (row.domain) domains.add(row.domain);
  }
  return domains.size > 0 ? [...domains] : [DEFAULT_DOMAIN];
}

// Retrieve the consolidated long-term memory records for one domain. Best-effort: a single
// failing domain (throttle, empty namespace) must not fail the whole route.
async function retrieveForDomain(
  agentcore: BedrockAgentCoreClient,
  domain: string,
): Promise<MemoryRecord[]> {
  const namespace = `reconciliation/lessons/${domain}`;
  try {
    // Mirrors backend retrieve_memory_records: memoryId + namespace + searchCriteria. A
    // non-empty query is required, so we pass the domain name to surface its records.
    const resp = await agentcore.send(
      new RetrieveMemoryRecordsCommand({
        memoryId: RECON_MEMORY_ID,
        namespace,
        searchCriteria: { searchQuery: domain, topK: TOP_K },
      }),
    );
    return (resp.memoryRecordSummaries ?? [])
      .map((r) => ({
        id: r.memoryRecordId ?? "",
        domain,
        namespace,
        // MemoryContent is a union member { text: ... }; unwrap the same field the backend reads.
        content: r.content && "text" in r.content ? (r.content.text ?? "") : "",
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : "",
      }))
      .filter((r) => r.content);
  } catch (err) {
    console.warn(
      `recon memory retrieve failed (domain ${domain}):`,
      (err as Error).message,
    );
    return [];
  }
}

export async function GET() {
  // Feature-gated: no configured memory -> empty list (same contract as reconMemory.ts).
  if (!RECON_MEMORY_ID) return NextResponse.json([]);
  try {
    const ddb = new DynamoDBClient({ region: REGION });
    const agentcore = new BedrockAgentCoreClient({ region: REGION });
    const domains = await listDomains(ddb);
    const perDomain = await Promise.all(
      domains.map((d) => retrieveForDomain(agentcore, d)),
    );
    return NextResponse.json(perDomain.flat());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

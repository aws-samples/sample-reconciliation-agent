import { NextResponse } from "next/server";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  BatchDeleteMemoryRecordsCommand,
  BedrockAgentCoreClient,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

import { authorizeRequest } from "@/lib/api-auth";
import { requireReconAdmin } from "@/lib/reconAdmin";

// Same-origin BFF: read the agent's CONSOLIDATED LONG-TERM MEMORY directly from AgentCore
// Memory (distinct from the DynamoDB recon-lessons ledger that /api/recon/lessons serves).
// The `lessons_learned` strategy (CUSTOM / SEMANTIC_OVERRIDE) extracts + consolidates analyst
// decisions into retrievable records under namespace reconciliation/lessons/{domain}; this route
// enumerates the recon domains (from the lessons ledger), retrieves those records for the Lessons
// tab, and deletes the ones an operator selects.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const RECON_MEMORY_ID = process.env.RECON_MEMORY_ID ?? "";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";
// Mirrors backend recon_core.lessons_recall: the actorId segment of the lessons namespace.
const DEFAULT_DOMAIN = "lending";
// Consolidated lessons per domain — a generous top_k so the tab shows the full recalled set.
const TOP_K = 25;
// Ceiling on one delete request. The panel shows one topK-bounded page per domain, so a legitimate
// "select all and delete" never approaches this; a request that does is a client bug or an attempt to
// wipe the agent's memory in one call, and both are better refused than serviced.
const MAX_DELETE_IDS = 50;

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

/**
 * Validate the id list a delete request carries.
 *
 * Throws rather than sanitising: a request asking to delete 60 records must be refused, not quietly
 * trimmed to 50, and a blank id must not silently become a no-op the caller reads as a success.
 *
 * @param body the parsed JSON request body.
 * @returns the de-duplicated record ids to delete.
 * @throws Error when the body is not `{ ids: string[] }`, is empty, holds a blank or non-string id,
 *   or exceeds `MAX_DELETE_IDS` after de-duplication.
 */
export function parseMemoryDeleteIds(body: unknown): string[] {
  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) {
    throw new Error("body must be an object with an `ids` array");
  }
  if (ids.length === 0) {
    throw new Error("`ids` must name at least one memory record");
  }
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new Error("every entry in `ids` must be a non-empty string");
    }
  }
  const unique = [...new Set((ids as string[]).map((id) => id.trim()))];
  if (unique.length > MAX_DELETE_IDS) {
    throw new Error(
      `at most ${MAX_DELETE_IDS} memory records may be deleted per request (got ${unique.length})`,
    );
  }
  return unique;
}

export async function GET(req: Request) {
  // Authenticated, but deliberately NOT admin-gated: any analyst who can open the Lessons tab can
  // already read these records, and the gate exists to stop an unauthenticated caller enumerating the
  // agent's memory from the internet. Deleting them is the privileged half — see DELETE.
  const auth = await authorizeRequest(req);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.message }, { status: auth.status });
  }
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

/**
 * Delete consolidated long-term memory records the operator selected.
 *
 * Admin-gated: removing what the agent recalls before every classification changes how the platform
 * behaves, so it gets the same gate as the Config tab rather than the read gate above.
 *
 * Returns 200 with a non-empty `failed` list on a partial failure — the UI shows which records
 * survived. A blanket 500 would leave the operator unable to tell which of their selection is gone.
 *
 * @param req the incoming request, body `{ ids: string[] }`.
 * @returns `{ deleted, failed }`, or an error response (401/403 unauthorized, 400 bad body,
 *   409 when no memory is configured, 500 when the batch call itself fails).
 */
export async function DELETE(req: Request) {
  const admin = await requireReconAdmin(req);
  if ("error" in admin) return admin.error;

  let ids: string[];
  try {
    ids = parseMemoryDeleteIds(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  // Unlike GET, an unconfigured memory is an error here. Answering 200 to a delete that deleted
  // nothing would tell the operator their records are gone when they are not — and if the variable is
  // missing, GET returned `[]`, so there was nothing on screen to select in the first place.
  if (!RECON_MEMORY_ID) {
    return NextResponse.json(
      {
        error:
          "RECON_MEMORY_ID is not configured, so there is no memory to delete from",
      },
      { status: 409 },
    );
  }

  try {
    const agentcore = new BedrockAgentCoreClient({ region: REGION });
    const resp = await agentcore.send(
      new BatchDeleteMemoryRecordsCommand({
        memoryId: RECON_MEMORY_ID,
        records: ids.map((id) => ({ memoryRecordId: id })),
      }),
    );
    return NextResponse.json({
      deleted: (resp.successfulRecords ?? []).map(
        (r) => r.memoryRecordId ?? "",
      ),
      failed: (resp.failedRecords ?? []).map((r) => ({
        id: r.memoryRecordId ?? "",
        error: r.errorMessage ?? "unknown error",
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

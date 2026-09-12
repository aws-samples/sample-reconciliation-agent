import { NextResponse } from "next/server";
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import { authorizeRequest } from "@/lib/api-auth";
import { requireReconAdmin } from "@/lib/reconAdmin";
import { reconMemoryClient } from "@/lib/reconMemory";
import type {
  MemoryClient,
  MemoryRecord as ConsolidatedRecord,
} from "@/lib/server/memoryClient";
import { parseMemoryDeleteIds } from "@/lib/server/memoryRequests";

// Re-exported because __tests__/api/reconMemoryDelete.test.ts reads the parser from this route.
export { parseMemoryDeleteIds };

// Same-origin BFF: read the agent's CONSOLIDATED LONG-TERM MEMORY directly from AgentCore
// Memory (distinct from the DynamoDB recon-lessons ledger that /api/recon/lessons serves).
// The `lessons_learned` strategy (CUSTOM / SEMANTIC_OVERRIDE) extracts + consolidates analyst
// decisions into retrievable records under namespace reconciliation/lessons/{domain}; this route
// enumerates the recon domains (from the lessons ledger), retrieves those records for the Lessons
// tab, and deletes the ones an operator selects.
//
// The SDK calls go through the shared client (lib/server/memoryClient.ts) bound to RECON_MEMORY_ID
// by lib/reconMemory.ts. What stays here is recon's own: the domain enumeration, the per-domain
// semantic retrieve and its best-effort degradation, and the `domain` on every record.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";
// Mirrors backend recon_core.lessons_recall: the actorId segment of the lessons namespace.
const DEFAULT_DOMAIN = "lending";
// Consolidated lessons per domain — a generous top_k so the tab shows the full recalled set.
const TOP_K = 25;

interface MemoryRecord extends ConsolidatedRecord {
  domain: string;
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
  memory: MemoryClient,
  domain: string,
): Promise<MemoryRecord[]> {
  const namespace = `reconciliation/lessons/${domain}`;
  try {
    // Mirrors backend retrieve_memory_records: memoryId + namespace + searchCriteria. A
    // non-empty query is required, so we pass the domain name to surface its records.
    const records = await memory.retrieveRecords(namespace, domain, TOP_K);
    // `namespace` is restated as the one asked for, so the wire shape stays exactly what it was.
    return records.map((r) => ({ ...r, domain, namespace }));
  } catch (err) {
    console.warn(
      `recon memory retrieve failed (domain ${domain}):`,
      (err as Error).message,
    );
    return [];
  }
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
  const memory = reconMemoryClient();
  if (!memory.configured) return NextResponse.json([]);
  try {
    const ddb = new DynamoDBClient({ region: REGION });
    const domains = await listDomains(ddb);
    const perDomain = await Promise.all(
      domains.map((d) => retrieveForDomain(memory, d)),
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
  const memory = reconMemoryClient();
  if (!memory.configured) {
    return NextResponse.json(
      {
        error:
          "RECON_MEMORY_ID is not configured, so there is no memory to delete from",
      },
      { status: 409 },
    );
  }

  try {
    const outcome = await memory.batchDelete(ids);
    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

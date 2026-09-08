/**
 * Read and write the operator-owned workflow-types table (`recon-workflow-types`).
 *
 * A workflow type names a category of document an operator may upload and says where an upload of
 * that category goes. Nothing the agent does reads this table — it describes the intake side — so
 * unlike the contacts table there is no send path here and no second reader whose verdict has to
 * agree. This module and the Config-tab routes above it are the whole story.
 *
 * The coherence rule (a route and its route-specific fields must agree) lives in `workflowTypes.ts`
 * and is applied by the route handler, not here. Kept separate so the rule can be tested without an
 * AWS client in the import graph.
 *
 * Split from `contactStore.ts` rather than shared with it because the two tables have different
 * keys and different audiences; the pagination helper IS shared, since an unfollowed continuation
 * token truncates a list the same way in both.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { nowStamp, scanAll } from "@/lib/contactStore";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const WORKFLOW_TYPES_TABLE =
  process.env.WORKFLOW_TYPES_TABLE ?? "recon-dev-workflow-types";

/** Where an upload of this type goes. */
export type WorkflowRoute = "extraction" | "knowledge-base";

/** A stored workflow-type row. */
export interface WorkflowType {
  workflow_type_id: string;
  display_name: string;
  route: WorkflowRoute;
  /** The extraction configuration version to pin. Empty on a knowledge-base route. */
  idp_config_version: string;
  /** The knowledge-base facet to stamp. Empty on an extraction route. */
  kb_doc_type: string;
  description?: string;
  /** Further object metadata to stamp on the upload. Free-form by design. */
  extra_metadata?: Record<string, string>;
  active: boolean;
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/** No workflow type answers to this id. Distinct from a read failure so the route can answer 404. */
export class WorkflowTypeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowTypeUnavailable";
  }
}

function ddb() {
  return new DynamoDBClient({ region: REGION });
}

/**
 * Every workflow type, INCLUDING deactivated ones.
 *
 * Deactivated rows are returned rather than filtered, for the same reason the contacts list keeps
 * them: they explain where documents already uploaded under that type went. The upload picker is
 * the caller that filters on `active`; the Config tab is not.
 *
 * @returns the rows, sorted by display name so the table does not reshuffle between saves.
 */
export async function listWorkflowTypes(): Promise<WorkflowType[]> {
  const rows = (await scanAll(
    WORKFLOW_TYPES_TABLE,
  )) as unknown as WorkflowType[];
  return rows.sort((a, b) =>
    (a.display_name ?? "").localeCompare(b.display_name ?? ""),
  );
}

/**
 * One raw workflow-type row, or null when the id is unknown.
 *
 * @param workflowTypeId - the partition key.
 * @returns the row, or null.
 */
export async function getWorkflowTypeRow(
  workflowTypeId: string,
): Promise<WorkflowType | null> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: WORKFLOW_TYPES_TABLE,
      Key: { workflow_type_id: { S: workflowTypeId } },
    }),
  );
  return resp.Item ? (unmarshall(resp.Item) as WorkflowType) : null;
}

/**
 * Create or replace one workflow type, stamping the audit attributes.
 *
 * The caller has already validated the row's coherence — this function does not re-check it, so
 * every write path must go through `workflowTypeRejectionReason` first.
 *
 * @param workflowType - the row to write; must carry `workflow_type_id`.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written.
 */
export async function putWorkflowType({
  workflowType,
  actor,
}: {
  workflowType: Partial<WorkflowType>;
  actor: string;
}): Promise<WorkflowType> {
  if (!workflowType.workflow_type_id)
    throw new WorkflowTypeUnavailable("workflow type is missing an id");
  const existing = await getWorkflowTypeRow(workflowType.workflow_type_id);
  const now = nowStamp();
  const row: WorkflowType = {
    ...(existing ?? {}),
    ...(workflowType as WorkflowType),
    active: Boolean(workflowType.active ?? existing?.active ?? true),
    // An edit must not rewrite who created the type: who introduced a document category, and when,
    // is the question worth being able to answer later.
    created_by: existing?.created_by ?? actor,
    created_at: existing?.created_at ?? now,
    updated_by: actor,
    updated_at: now,
  };
  await ddb().send(
    new PutItemCommand({
      TableName: WORKFLOW_TYPES_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

/**
 * Soft-delete one workflow type by clearing `active`.
 *
 * Never a `DeleteItem`. Retiring a type takes it out of the upload picker, which is the whole
 * intent; removing the row would also erase the record of which extraction configuration the
 * documents already uploaded under it were processed against.
 *
 * @param workflowTypeId - the type to deactivate.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written.
 * @throws WorkflowTypeUnavailable when no such type exists — deactivating nothing is not success.
 */
export async function deactivateWorkflowType({
  workflowTypeId,
  actor,
}: {
  workflowTypeId: string;
  actor: string;
}): Promise<WorkflowType> {
  const existing = await getWorkflowTypeRow(workflowTypeId);
  if (!existing)
    throw new WorkflowTypeUnavailable(
      `workflow type ${workflowTypeId} does not exist`,
    );
  const row: WorkflowType = {
    ...existing,
    active: false,
    updated_by: actor,
    updated_at: nowStamp(),
  };
  await ddb().send(
    new PutItemCommand({
      TableName: WORKFLOW_TYPES_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

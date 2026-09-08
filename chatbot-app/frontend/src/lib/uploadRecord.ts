/**
 * Read and write the upload-submissions table (`recon-idp-uploads`).
 *
 * One row per submission, not per file, because a submission is the unit an operator performs and
 * the unit that has to be reconstructible afterwards: a `.msg` and the two attachments it carried
 * are one act, and splitting them into three rows loses the link that says so.
 *
 * A row is written BEFORE either destination is touched and updated after each file lands. That
 * ordering is the point. If the process dies between the record and the put, the tab shows a
 * submission whose files are still PENDING, which is a visible loose end; if the row were written
 * last, the same crash would leave an object sitting in a bucket that nothing in recon knows about.
 *
 * On the recency index: the tab asks for "the most recent submissions", and Scan cannot answer that
 * -- it returns items in no defined order, so sorting the page you happened to get is correct only
 * while the table fits in one page. Every row therefore carries the same `gsi_bucket` value so the
 * index has one partition sorted by timestamp. That is a deliberate hot partition, and it is fine
 * here for a reason worth stating: the writer is a human choosing files in a browser, which is
 * several orders of magnitude below the per-partition write ceiling that makes this shape a mistake
 * in a high-throughput table.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";

/**
 * The upload audit table's name, with no fallback on purpose.
 *
 * A default would let this module run against the wrong table -- or against a table that does not
 * exist in whatever account it was deployed to -- and report success. Terraform sets this variable
 * on the task definition; if it is missing, the deployment is wrong.
 *
 * A function called per use, not a constant read at module load, and this matters rather than
 * being style: `next build` imports every route module to collect its metadata, and the build
 * container has none of the runtime's environment. A throw at load time would fail the build
 * instead of the misconfigured deployment. This mirrors `usersTableName()` in
 * `src/lib/deployment-env.ts`, which is the existing convention for exactly this.
 *
 * @returns The table name.
 * @throws Error when `UPLOADS_TABLE` is unset.
 */
function uploadsTable(): string {
  const name = process.env.UPLOADS_TABLE;
  if (!name) {
    throw new Error(
      "UPLOADS_TABLE is not set; the upload audit table name has to come from the environment",
    );
  }
  return name;
}

/** The single partition every row shares so the recency index can be queried in order. */
export const RECENCY_BUCKET = "submission";

/**
 * Where one file of a submission has got to.
 *
 * `UPLOADED` is honest about its own limits: the object is in the bucket, and for an extraction
 * upload that is all recon can know -- the pipeline's own status arrives later through
 * `listDocuments`. `PENDING_INGESTION` exists because a knowledge-base object is NOT searchable when
 * the put returns; it becomes searchable when an ingestion job completes, minutes later. Reporting a
 * KB upload as done at put time would be a lie the tab tells every time.
 */
export type FileStatus =
  "PENDING" | "UPLOADED" | "PENDING_INGESTION" | "INGESTED" | "FAILED";

export interface SubmissionFile {
  /**
   * The name the operator's file had. This, not `object_key`, is a file's identity within a
   * submission: a row exists from the moment the submission is written, and at that point the
   * object key is not known yet. `putSubmission` refuses duplicate filenames so the identity
   * holds.
   */
  filename: string;
  /** Where the file itself landed. Empty until the put succeeds. */
  object_key: string;
  status: FileStatus;
  size_bytes: number;
  /**
   * The parts an email was split into, when this file was a `.msg` or `.eml`. The email keeps one
   * row -- one row per file the operator picked -- and this lists what came out of it, so the tab
   * can show that a single upload became four documents.
   */
  derived_object_keys?: string[];
  /** Why this file failed. Present only on FAILED, and shown to the operator verbatim. */
  error?: string;
}

export interface Submission {
  submission_id: string;
  workflow_type: string;
  route: "extraction" | "knowledge-base";
  /** The version recon ASKED for. Empty on a knowledge-base route. */
  config_version: string;
  uploaded_by: string;
  uploaded_at?: string;
  files: SubmissionFile[];
}

function ddb(): DynamoDBClient {
  return new DynamoDBClient({ region: REGION });
}

/**
 * Write a submission row.
 *
 * @param submission - the submission; `uploaded_at` is stamped here when absent.
 * @returns the row as written, including the stamped timestamp.
 * @throws Error when the submission carries no files.
 */
export async function putSubmission(
  submission: Submission,
): Promise<Submission> {
  // Refused rather than written. A row with no files records that somebody pressed upload and
  // nothing happened, which is indistinguishable on the tab from a submission still in flight.
  if (submission.files.length === 0) {
    throw new Error("a submission needs at least one file");
  }
  // Filename is how `markFileStatus` finds a file, so two files sharing one is not a cosmetic
  // problem: a status update would patch both rows and the operator would be told the wrong file
  // failed. Refused here rather than silently deduplicated, because the operator picked both files
  // and deserves to know only one would have been recorded.
  const names = submission.files.map((f) => f.filename);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) {
    throw new Error(
      `two files in this submission are both named "${duplicate}"; rename one and upload again`,
    );
  }
  const row = {
    ...submission,
    uploaded_at: submission.uploaded_at ?? new Date().toISOString(),
  };
  await ddb().send(
    new PutItemCommand({
      TableName: uploadsTable(),
      Item: marshall(
        { ...row, gsi_bucket: RECENCY_BUCKET },
        { removeUndefinedValues: true },
      ),
    }),
  );
  return row;
}

/**
 * Move one file of a submission to a new status.
 *
 * Implemented as a read-modify-write of the whole `files` list rather than an indexed update, because
 * the index of a file within the list is not stable information the caller has -- it knows the
 * filename. A conditional expression on the list contents would be the fully safe version; it is not
 * used here because the only two writers are the upload route (once per file, at creation) and the
 * ingestion Lambda (which runs with reserved concurrency 1), so there is no concurrent second writer
 * to lose an update to. If a third writer ever appears, this needs the condition.
 *
 * Keyed by filename, not object key: the row is written before anything is put, so at that moment
 * the key is empty. The filename is the one field that is known for a file's whole life, and
 * `putSubmission` refuses a submission where it would be ambiguous.
 *
 * @param params.submissionId - the row to update.
 * @param params.filename - which file within it.
 * @param params.patch - the file's new state, replacing the stored entry wholesale.
 * @returns nothing.
 */
export async function markFileStatus(params: {
  submissionId: string;
  filename: string;
  patch: SubmissionFile;
}): Promise<void> {
  const client = ddb();
  const current = await client.send(
    new GetItemCommand({
      TableName: uploadsTable(),
      Key: { submission_id: { S: params.submissionId } },
      // Required, not an optimization. The caller updates the files of one submission one after
      // another, and a default eventually-consistent read can hand back the row as it was BEFORE
      // the previous file's write landed. The rewrite below would then re-persist that stale list
      // and silently revert every file settled so far to PENDING.
      //
      // GetItem rather than Query for the same reason a key lookup is not a search: this is a read
      // of one known primary key, and Query would return a list whose first element happens to be
      // the row.
      ConsistentRead: true,
    }),
  );
  const row = current.Item
    ? (unmarshall(current.Item) as Submission)
    : undefined;
  // Loud on a missing row. A status update for a submission that does not exist means the writer and
  // the reader disagree about the id, and swallowing it would leave a file permanently PENDING.
  if (!row) {
    throw new Error(`no submission ${params.submissionId} to update`);
  }
  if (!row.files.some((f) => f.filename === params.filename)) {
    throw new Error(
      `submission ${params.submissionId} has no file named ${params.filename}`,
    );
  }
  const files = row.files.map((file) =>
    file.filename === params.filename ? params.patch : file,
  );
  await client.send(
    new UpdateItemCommand({
      TableName: uploadsTable(),
      Key: { submission_id: { S: params.submissionId } },
      // `status_updated_at`, deliberately NOT `uploaded_at`. The latter is the recency index's
      // range key and the submission's true submit time; bumping it here would reorder the tab on
      // every ingestion pass and push the FAILED deadline forward forever.
      UpdateExpression: "SET files = :files, status_updated_at = :touched",
      ExpressionAttributeValues: marshall(
        { ":files": files, ":touched": new Date().toISOString() },
        { removeUndefinedValues: true },
      ),
    }),
  );
}

/**
 * Read the most recent submissions, newest first.
 *
 * @param params.limit - maximum rows to return.
 * @returns the rows, newest first.
 */
export async function listRecentSubmissions(params: {
  limit: number;
}): Promise<Submission[]> {
  const client = ddb();
  const rows: Submission[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(
      new QueryCommand({
        TableName: uploadsTable(),
        IndexName: "by_recency",
        KeyConditionExpression: "gsi_bucket = :bucket",
        ExpressionAttributeValues: marshall({ ":bucket": RECENCY_BUCKET }),
        // Newest first. The index's range key is the timestamp, so this is a descending scan of it.
        ScanIndexForward: false,
        Limit: params.limit,
        ExclusiveStartKey: startKey as never,
      }),
    );
    for (const item of page.Items ?? []) {
      rows.push(unmarshall(item) as Submission);
    }
    // Followed rather than ignored: DynamoDB returns a partial page whenever it feels like it, and an
    // unfollowed token silently truncates the list to whatever the first page happened to hold.
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey && rows.length < params.limit);
  return rows.slice(0, params.limit);
}

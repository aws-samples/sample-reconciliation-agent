/**
 * Accepts operator uploads and forwards them to whichever destination the workflow type names.
 *
 * `POST` takes a multipart form: a `route`, the route's descriptors, and one or more `files`.
 *
 * Ordering inside the handler is load-bearing. The audit row is written before any put and
 * updated after each one, so a crash in between leaves a visible PENDING row rather than an
 * object in a destination bucket that recon has no record of sending. For the extraction route
 * that object is already being processed by the time anyone notices, which is why the row cannot
 * be written afterwards as a summary.
 *
 * Files are handled independently and a rejected file does not fail the submission. The response
 * carries a per-file status and, on failure, the reason. A single 400 for the whole request
 * would make an operator re-pick a dozen files to find the one that was wrong.
 *
 * Two things this route does not do, both on purpose:
 *
 *   - It does not start a knowledge-base ingestion job. Ingestion is debounced and serialized by
 *     a separate Lambda, because the KB accepts one job at a time and an operator uploading six
 *     files would otherwise start six jobs, five of which fail. A KB-routed file therefore ends
 *     at PENDING_INGESTION, and something else moves it to INGESTED.
 *   - It does not stream file bytes to a Lambda. The email pre-processor reads from S3 and writes
 *     back, because a synchronous invoke caps at 6 MB and the upload allowlist permits 100 MB.
 *     The route then copies each derived part server-side, so no file's bytes pass through this
 *     task twice.
 */

import { randomUUID } from "node:crypto";

import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  CopyObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { requireReconAdmin } from "@/lib/reconAdmin";
import { destinationFor } from "@/lib/uploadDestination";
import {
  contentTypeFor,
  extensionOf,
  sanitizeFilename,
  uploadRejectionReason,
} from "@/lib/uploadPolicy";
import {
  listRecentSubmissions,
  markFileStatus,
  putSubmission,
  type SubmissionFile,
} from "@/lib/uploadRecord";

const s3 = new S3Client({});
const lambda = new LambdaClient({});

/** Extensions the pre-processor handles. Everything else is uploaded as it arrived. */
const EMAIL_EXTENSIONS = new Set([".msg", ".eml"]);

/**
 * Resolve a destination's logical bucket name to the real one.
 *
 * @param logical - Which destination `destinationFor` chose.
 * @returns The bucket name from the environment.
 * @throws If the variable is unset. A missing bucket name is a broken deployment, and defaulting
 *   it would put operator uploads somewhere nobody is watching.
 */
function bucketName(logical: "idp-input" | "recon-assets"): string {
  const variable =
    logical === "idp-input" ? "IDP_INPUT_BUCKET" : "UPLOAD_STAGING_BUCKET";
  const value = process.env[variable];
  if (!value)
    throw new Error(`${variable} is not set, so uploads have nowhere to go`);
  return value;
}

/**
 * The pre-processor's function name.
 *
 * Checked rather than passed through, because an unset variable reaches the SDK as
 * `FunctionName: undefined` and comes back as a schema-validation error that names the field and
 * not the deployment -- so the operator sees "email upload failed" and has no way to tell a
 * missing environment variable from a Lambda that threw.
 *
 * @returns The function name.
 * @throws Error when `EMAIL_PREPROCESS_FUNCTION` is unset.
 */
function preprocessFunctionName(): string {
  const value = process.env.EMAIL_PREPROCESS_FUNCTION;
  if (!value)
    throw new Error(
      "EMAIL_PREPROCESS_FUNCTION is not set, so .msg and .eml uploads cannot be split into parts",
    );
  return value;
}

/**
 * Handle an upload submission.
 *
 * @param req - The multipart request.
 * @returns 200 with a per-file result, or the gate's own 401/403/503 response unchanged.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const gate = await requireReconAdmin(req);
  if ("error" in gate) return gate.error;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `could not read the upload form: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const route = String(formData.get("route") ?? "");
  if (route !== "extraction" && route !== "knowledge-base") {
    return NextResponse.json(
      {
        error: `route must be "extraction" or "knowledge-base", not "${route}"`,
      },
      { status: 400 },
    );
  }
  const uploads = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File);
  if (uploads.length === 0) {
    return NextResponse.json(
      { error: "no files in the submission" },
      { status: 400 },
    );
  }

  const submissionId = randomUUID();
  // Stamped here, once, rather than left to `putSubmission`'s default. Two readers need the same
  // value: the audit row, and every sidecar that has no received date of its own and falls back
  // to when the file was submitted. Calling `new Date()` twice would date the row and the sidecar
  // a few milliseconds apart, which is harmless today and is exactly the kind of drift that turns
  // into an unexplainable off-by-one the first time a submission straddles midnight UTC.
  const uploadedAt = new Date().toISOString();
  const files: SubmissionFile[] = uploads.map((file) => ({
    filename: file.name,
    object_key: "",
    status: "PENDING",
    size_bytes: file.size,
  }));

  // Before any put. See the header comment. `putSubmission` also refuses a submission with two
  // identically named files, and that refusal is a 400 for the whole request rather than a
  // per-file failure -- the route cannot tell the operator which of the two it dropped.
  try {
    await putSubmission({
      submission_id: submissionId,
      workflow_type: String(formData.get("workflowTypeId") ?? ""),
      route,
      config_version: String(formData.get("configVersion") ?? ""),
      uploaded_by: gate.actor,
      uploaded_at: uploadedAt,
      files,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }

  const results: SubmissionFile[] = [];
  for (const file of uploads) {
    results.push(
      await handleOneFile({
        file,
        route,
        formData,
        submissionId,
        uploadedAt,
      }),
    );
  }

  return NextResponse.json({ submissionId, files: results });
}

/**
 * Validate, pre-process if needed, and upload one file.
 *
 * @param args.file - The uploaded file.
 * @param args.route - Which destination the submission chose.
 * @param args.formData - The whole form, read for the route's descriptors.
 * @param args.submissionId - The audit row this file belongs to.
 * @param args.uploadedAt - When the submission was received, as an ISO 8601 string. Dates any
 *   sidecar whose document carries no received date of its own.
 * @returns The file's final row, with `status` and — on refusal — `error` set.
 */
async function handleOneFile(args: {
  file: File;
  route: "extraction" | "knowledge-base";
  formData: FormData;
  submissionId: string;
  uploadedAt: string;
}): Promise<SubmissionFile> {
  const { file, route, formData, submissionId, uploadedAt } = args;
  const base: SubmissionFile = {
    filename: file.name,
    object_key: "",
    status: "PENDING",
    size_bytes: file.size,
  };

  // Every refusal in this function follows the same shape: record it against the file, return
  // the row, and let the submission continue. Throwing would abandon the files after this one
  // and leave their rows at PENDING forever.
  const fail = async (reason: string): Promise<SubmissionFile> => {
    const failed: SubmissionFile = { ...base, status: "FAILED", error: reason };
    await markFileStatus({ submissionId, filename: file.name, patch: failed });
    return failed;
  };

  const rejection = uploadRejectionReason({
    filename: file.name,
    bytes: file.size,
  });
  if (rejection) return fail(rejection);

  let safeName: string;
  try {
    safeName = sanitizeFilename(file.name);
  } catch (err) {
    return fail((err as Error).message);
  }

  const extension = extensionOf(safeName);
  if (EMAIL_EXTENSIONS.has(extension)) {
    return preprocessAndUpload({
      file,
      safeName,
      route,
      formData,
      submissionId,
      uploadedAt,
    });
  }

  try {
    const destination = destinationFor({
      route,
      filename: safeName,
      // Derived from the extension, never read off the upload. `file.type` is the uploading
      // machine's opinion and is empty on any machine with no association for the extension, which
      // on the knowledge-base route produces a document that indexes clean and holds no text.
      contentType: contentTypeFor(safeName),
      configVersion: String(formData.get("configVersion") ?? "") || undefined,
      docType: (String(formData.get("docType") ?? "") || undefined) as never,
      breakClasses: formData.getAll("breakClasses").map(String),
      skills: formData.getAll("skills").map(String),
      subject: String(formData.get("subject") ?? ""),
      uploadedAt,
    });
    await putToDestination({
      destination,
      body: Buffer.from(await file.arrayBuffer()),
    });
    // UPLOADED means the object is where it belongs and the destination owns it from here.
    // PENDING_INGESTION means the object is in place but the corpus does not contain it yet:
    // the KB only reflects a document after an ingestion job has scanned it, and this route
    // deliberately does not start one.
    const status =
      route === "knowledge-base" ? "PENDING_INGESTION" : "UPLOADED";
    const done: SubmissionFile = {
      ...base,
      object_key: destination.key,
      status,
    };
    await markFileStatus({ submissionId, filename: file.name, patch: done });
    return done;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * Write an object and, when the destination uses one, its sidecar.
 *
 * @param args.destination - What `destinationFor` resolved.
 * @param args.body - The object's bytes.
 * @throws Whatever S3 raises. The caller turns it into a FAILED row.
 */
async function putToDestination(args: {
  destination: ReturnType<typeof destinationFor>;
  body: Buffer;
}): Promise<void> {
  const { destination, body } = args;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(destination.bucket),
      Key: destination.key,
      Body: body,
      ContentType: destination.contentType,
      Metadata: destination.metadata,
    }),
  );
  if (destination.sidecar) {
    // The sidecar goes second. If it failed and the object had not been written, the KB would
    // hold nothing; written in this order, a sidecar failure leaves a document that indexes
    // with no attributes -- visible in the audit row as PENDING_INGESTION with an error, and
    // fixable by re-uploading, rather than an object nobody can account for.
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName(destination.bucket),
        Key: destination.sidecar.key,
        Body: destination.sidecar.body,
        ContentType: "application/json",
      }),
    );
  }
}

/**
 * Stage an email, split it in the pre-processor, and forward the parts.
 *
 * @param args.file - The uploaded `.msg` or `.eml`.
 * @param args.safeName - The sanitized filename.
 * @param args.route - Which destination the parts go to.
 * @param args.formData - The submission's descriptors.
 * @param args.submissionId - The audit row.
 * @param args.uploadedAt - When the submission was received, as an ISO 8601 string. Passed
 *   through to the parts, because a part the pre-processor could not date needs one.
 * @returns A row for the email itself. Its `status` reflects the parts: UPLOADED (or
 *   PENDING_INGESTION) when every part was forwarded, FAILED with the reason when the email
 *   could not be split.
 */
async function preprocessAndUpload(args: {
  file: File;
  safeName: string;
  route: "extraction" | "knowledge-base";
  formData: FormData;
  submissionId: string;
  uploadedAt: string;
}): Promise<SubmissionFile> {
  const { file, safeName, route, formData, submissionId, uploadedAt } = args;
  const stagingBucket = bucketName("recon-assets");
  const sourceKey = `uploads/inbox/${submissionId}/${safeName}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: stagingBucket,
      Key: sourceKey,
      Body: Buffer.from(await file.arrayBuffer()),
      ContentType: "message/rfc822",
    }),
  );

  const response = await lambda.send(
    new InvokeCommand({
      FunctionName: preprocessFunctionName(),
      Payload: Buffer.from(
        JSON.stringify({
          submission_id: submissionId,
          source_key: sourceKey,
          filename: safeName,
        }),
      ),
    }),
  );
  const result = JSON.parse(
    Buffer.from(response.Payload ?? []).toString() || "{}",
  );

  if (result.error) {
    const failed: SubmissionFile = {
      filename: file.name,
      object_key: sourceKey,
      status: "FAILED",
      size_bytes: file.size,
      error: result.error,
    };
    await markFileStatus({ submissionId, filename: file.name, patch: failed });
    return failed;
  }
  return forwardParts({
    parts: result.parts,
    file,
    sourceKey,
    route,
    formData,
    submissionId,
    uploadedAt,
  });
}

/**
 * Copy each derived part from the staging bucket to its real destination.
 *
 * Server-side CopyObject, not a read-then-put: both buckets are in the same account and region,
 * so the bytes never pass through this task. Each part's row records `parent_object_key` so the
 * tab can show which email a document came from.
 *
 * @param args.parts - The pre-processor's manifest.
 * @param args.file - The original email, whose row this returns.
 * @param args.sourceKey - The staged email's key, recorded as each part's parent.
 * @param args.route - Which destination the parts go to.
 * @param args.formData - The submission's descriptors.
 * @param args.submissionId - The audit row.
 * @param args.uploadedAt - When the submission was received, as an ISO 8601 string.
 * @returns The email's own row, FAILED if any part could not be forwarded.
 */
async function forwardParts(args: {
  parts: Array<Record<string, string | string[]>>;
  file: File;
  sourceKey: string;
  route: "extraction" | "knowledge-base";
  formData: FormData;
  submissionId: string;
  uploadedAt: string;
}): Promise<SubmissionFile> {
  const { parts, file, sourceKey, route, formData, submissionId, uploadedAt } =
    args;
  const stagingBucket = bucketName("recon-assets");
  const forwarded: string[] = [];

  for (const part of parts) {
    const destination = destinationFor({
      route,
      filename: String(part.filename),
      contentType: String(part.content_type),
      configVersion: String(formData.get("configVersion") ?? "") || undefined,
      // An attachment is its own document type in the seeded corpus, and it carries
      // attachment_format in place of has_attachments. Getting this wrong indexes an
      // attachment as if it were the email body.
      docType: (part.kind === "attachment"
        ? "email_attachment"
        : "email") as never,
      breakClasses: formData.getAll("breakClasses").map(String),
      skills: formData.getAll("skills").map(String),
      subject: String(part.subject ?? ""),
      sender: String(part.sender ?? ""),
      recipients: (part.recipients as string[]) ?? [],
      messageId: String(part.message_id ?? ""),
      receivedDate: String(part.received_date ?? ""),
      hasAttachments: parts.some((p) => p.kind === "attachment"),
      attachmentFormat: String(part.attachment_format ?? "") || undefined,
      uploadedAt,
    });

    await s3.send(
      new CopyObjectCommand({
        Bucket: bucketName(destination.bucket),
        Key: destination.key,
        // Encoded per path SEGMENT, never as one string. `encodeURIComponent` escapes `/` to
        // `%2F`, and a CopySource whose slashes are escaped names a single flat key that does
        // not exist, so every copy out of `uploads/derived/<id>/...` would 404. Splitting first
        // keeps the separators literal while still escaping a space or `#` inside a filename,
        // which S3 requires.
        CopySource: `${stagingBucket}/${String(part.key)
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        ContentType: destination.contentType,
        Metadata: destination.metadata,
        // Without this, CopyObject carries the source object's metadata over and the
        // config-version pin set above is silently discarded.
        MetadataDirective: "REPLACE",
      }),
    );
    if (destination.sidecar) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucketName(destination.bucket),
          Key: destination.sidecar.key,
          Body: destination.sidecar.body,
          ContentType: "application/json",
        }),
      );
    }
    forwarded.push(destination.key);
  }

  const status = route === "knowledge-base" ? "PENDING_INGESTION" : "UPLOADED";
  // One row per file the operator picked. `object_key` is where the email itself was staged --
  // a real object they can go and look at -- and the parts it became are listed separately. The
  // earlier temptation was to join the part keys into `object_key`; that would have produced a
  // comma-separated string in a field every other row uses as a single key.
  const row: SubmissionFile = {
    filename: file.name,
    object_key: sourceKey,
    derived_object_keys: forwarded,
    status,
    size_bytes: file.size,
  };
  await markFileStatus({ submissionId, filename: file.name, patch: row });
  return row;
}

/** The largest page this route will read, whatever the caller asked for. */
const MAX_LIMIT = 100;

/**
 * List recent submissions, newest first.
 *
 * The Documents tab needs this alongside the pipeline's own document list, because two kinds of row
 * exist only here: a knowledge-base upload, which the pipeline never sees, and a file that was
 * refused before it reached a bucket, which has no pipeline record to appear in.
 *
 * @param req - The request. `?limit=` is honoured up to MAX_LIMIT.
 * @returns 200 with `{ submissions }`, or the gate's own response unchanged.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const gate = await requireReconAdmin(req);
  if ("error" in gate) return gate.error;

  const asked = Number(new URL(req.url).searchParams.get("limit") ?? "25");
  // Clamped, not validated-and-rejected: a bad limit is a UI bug, not an operator error, and
  // failing the whole list over it would leave the tab blank.
  const limit = Number.isFinite(asked)
    ? Math.min(Math.max(Math.trunc(asked), 1), MAX_LIMIT)
    : 25;

  try {
    const submissions = await listRecentSubmissions({ limit });
    return NextResponse.json({ submissions });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}

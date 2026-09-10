/**
 * Decides where an uploaded file goes, and what has to travel with it.
 *
 * The two routes are not two prefixes of one scheme; they are different destinations with
 * different requirements, and this module is the only place that knows which is which.
 *
 * Extraction: the document pipeline's input bucket, at the root, under the plain filename --
 * matching the objects already there. The object carries `config-version` metadata naming the
 * configuration row that should govern its extraction. That convention is already live in this
 * environment; an object without it is not rejected, the pipeline just resolves whichever
 * configuration is active at that moment. Since that silent resolution is precisely what the
 * audit row exists to detect, an unpinned upload is refused here instead of created.
 *
 * Knowledge base: recon's own assets bucket, under `knowledge-base/uploads/`, with a
 * `.metadata.json` sidecar written beside the object.
 *
 * Two facts force a separate bucket rather than a prefix in the pipeline's:
 *
 *   1. The pipeline's KB ingestion is wired to its input bucket on ObjectCreated:Put with no
 *      prefix filter. Every object put there is both extracted and ingested into a knowledge
 *      base recon does not read, and there is no extraction-only prefix to hide behind.
 *   2. recon's own KB data source already includes `knowledge-base/`, so an object under it
 *      needs no infrastructure change to be in scope.
 *
 * The `uploads/` sub-prefix is equally deliberate. `knowledge-base/playbooks/` and
 * `knowledge-base/retrieved_emails/` are Terraform-managed by exact object key: an upload
 * landing on one of those keys would be reverted by the next apply, with nothing reported.
 * `uploads/` is the one place under that prefix Terraform does not manage.
 */

import { buildSidecar, type KbDocType } from "@/lib/kbSidecar";
// `workflowTypeStore`, not `workflowTypes`. The type lives with the store that persists it, and this
// is a type-only import, so it is erased at compile and drags no DynamoDB client into any bundle.
import type { WorkflowRoute } from "@/lib/workflowTypeStore";

/** The only prefix under `knowledge-base/` that Terraform does not manage by exact key. */
export const KB_UPLOAD_PREFIX = "knowledge-base/uploads/";

/** What the route needs to perform one put, and to record what it did. */
export interface UploadDestination {
  /** Which bucket, resolved by the caller from its environment. */
  bucket: "idp-input" | "recon-assets";
  /** The object key. */
  key: string;
  /** The object's Content-Type. */
  contentType: string;
  /** Custom S3 object metadata. Empty for the knowledge-base route. */
  metadata: Record<string, string>;
  /** The sidecar to write beside the object, or null when the route does not use one. */
  sidecar: { key: string; body: string } | null;
}

/** Everything either route might need. Which fields are required depends on `route`. */
export interface DestinationRequest {
  route: WorkflowRoute;
  filename: string;
  contentType: string;
  /**
   * When the submission was made, ISO-8601. Required, and passed in rather than read from the clock
   * here so the same request always produces the same sidecar.
   *
   * It is the fallback for `receivedDate`: a plain PDF has no received date, and the sidecar's
   * `received_date`/`effective_date` are NUMBER attributes the corpus filters on, so there is no
   * "absent" to fall back to. Dating such a document by when it was uploaded is the only answer
   * that keeps it inside a date filter.
   */
  uploadedAt: string;
  /** Extraction only: the configuration row to pin. Required for that route. */
  configVersion?: string;
  /** Knowledge base only: required for that route. */
  docType?: KbDocType;
  breakClasses?: string[];
  skills?: string[];
  subject?: string;
  sender?: string;
  recipients?: string[];
  messageId?: string;
  receivedDate?: string;
  hasAttachments?: boolean;
  attachmentFormat?: string;
}

/**
 * Resolve where one file goes.
 *
 * @param request - The route and the file's descriptors.
 * @returns The bucket, key, content type, metadata, and sidecar for a single put.
 * @throws If a field the chosen route requires is missing. Both refusals exist because the
 *   corresponding upload would succeed and then be wrong in a way nothing reports: an
 *   unpinned extraction resolves an arbitrary configuration, and a KB document with no doc
 *   type indexes with attributes the retrieval filters cannot match.
 */
export function destinationFor(request: DestinationRequest): UploadDestination {
  if (request.route === "extraction") {
    if (!request.configVersion) {
      throw new Error(
        `${request.filename}: an extraction upload needs a config version to pin. ` +
          "Without one the pipeline uses whichever configuration is active, and the audit " +
          "row has nothing to compare its answer against.",
      );
    }
    return {
      bucket: "idp-input",
      // No prefix. The pipeline's existing objects sit at the bucket root under their plain
      // filenames, and its event rule matches the whole bucket, so a prefix would buy nothing
      // and make recon's uploads look unlike everything else there.
      key: request.filename,
      contentType: request.contentType,
      metadata: { "config-version": request.configVersion },
      sidecar: null,
    };
  }

  if (!request.docType) {
    throw new Error(
      `${request.filename}: a knowledge-base upload needs a doc type. The retrieval filters ` +
        "match on it, so a document without one is indexed but never found.",
    );
  }

  const key = `${KB_UPLOAD_PREFIX}${request.filename}`;
  return {
    bucket: "recon-assets",
    key,
    contentType: request.contentType,
    // The knowledge-base connector reads the sidecar, not object metadata. Setting custom
    // metadata here would be written, cost nothing, and be read by nobody.
    metadata: {},
    sidecar: {
      key: `${key}.metadata.json`,
      body: JSON.stringify(
        buildSidecar({
          docType: request.docType,
          // The two names differ on purpose and must not be "tidied" to match: this request object
          // is built from form fields, and `SidecarInput` is named after the sidecar attributes it
          // emits (`break_class`, `receiver`). Renaming either side silently drops the attribute.
          breakClass: request.breakClasses ?? [],
          skills: request.skills ?? [],
          subject: request.subject ?? "",
          sender: request.sender ?? "",
          receiver: request.recipients ?? [],
          messageId: request.messageId ?? "",
          // Falls back to the submission time. An empty string here reaches `yyyymmdd("")`, which
          // throws and fails the whole request — and any knowledge-base upload that is not an email
          // has no received date to supply (a plain PDF carries none).
          receivedDate: request.receivedDate || request.uploadedAt,
          hasAttachments: request.hasAttachments ?? false,
          attachmentFormat: request.attachmentFormat,
        }),
      ),
    },
  };
}

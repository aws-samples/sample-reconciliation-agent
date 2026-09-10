/**
 * What the extractor read out of one document, read from recon's OWN notice row.
 *
 * Server-side only, and deliberately NOT a call to the document pipeline's GraphQL API. Going there
 * (one `getDocument` for the section pointers, then one `getFileContents` per section to read the
 * result JSON behind each pointer) fails 401 in the deployed console, because `appsync:GraphQL` is
 * authorised per FIELD and the ECS task role is granted only `listDocuments` and `getDocument`.
 * Widening that grant would not be the right fix either:
 *
 *   - a field-scoped grant on somebody else's API can only be verified by the principal that will
 *     make the call, so "the schema accepts IAM callers" is not evidence the task role may call it;
 *   - reading the result JSON here would mean re-implementing `backend/idp_hook/explainability.py`
 *     in TypeScript, and the UI must never compute an extraction confidence differently from the
 *     hook, whose number is what the gateway interceptor refuses ledger writes on.
 *
 * The hook already holds every value and every per-field confidence at ingest, so it embeds them on
 * the notice row (`idp_sections`) exactly as it embeds the page-image locations (`idp_pages`). This
 * module reads that attribute back. There is one implementation of the flattening rules, in Python,
 * and this file does no arithmetic at all.
 *
 * The row is keyed `idp-<ObjectKey>` — see `idp_event_to_notice`, which derives the id that way so a
 * re-delivered completion event overwrites rather than duplicates.
 */

import {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";

/** One scored leaf of the extractor's explainability data, paired with the value it describes. */
export interface ExtractedFieldConfidence {
  /** Dotted/bracketed path, e.g. `amount` or `AccrualLineItems[1].Amount`. */
  field: string;
  confidence: number;
  /** The extractor's threshold for THIS field. Per-field: 0.8 and 0.9 both occur live. */
  threshold: number | null;
  /** False when the extractor produced nothing here — an absent optional field it still scored. */
  extracted: boolean;
  /**
   * The value this score describes, as the hook paired the two. Carried through rather than dropped
   * because it is what the pairing was made on. The panel still joins on `field` against `fields`,
   * so a renderer never has to choose between two copies of the same value.
   */
  value?: unknown;
}

/** One section of one document: what it was classified as, what came out of it, how sure IDP was. */
export interface ExtractedSection {
  section_id: string | null;
  classification: string | null;
  page_ids: number[];
  /** The extractor's `inference_result`, verbatim. Key order is the extraction schema's. */
  fields: Record<string, unknown>;
  confidences: ExtractedFieldConfidence[];
  /** Mean confidence over the fields the extractor read a value for, or null when there is none. */
  mean_confidence: number | null;
  /** Fields scored below their OWN threshold. 0 is meaningful: checked, nothing flagged. */
  alert_count: number;
  /** Why this section could not be shown, when it could not. Named rather than left blank. */
  error?: string;
}

/**
 * One document's embedded extraction.
 *
 * `unavailable` is set when the row EXISTS but carries no per-field detail, which is a different
 * answer from having no row at all and is reported as such rather than as an error. Which of those
 * two the operator is looking at matters: for a notice the document was extracted and only the
 * display detail is missing, whereas for a tracking-only row no notice was ever mapped. See
 * `unavailableReason`, which tells them apart from the row rather than by inference.
 */
export interface NoticeExtraction {
  sections: ExtractedSection[];
  unavailable: string | null;
}

/** Raised when recon has no notice row for the key, so the caller can answer 404. */
export class UnknownDocumentError extends Error {}

/**
 * The notices table's name, with no fallback on purpose.
 *
 * A default would let this read the wrong table — or a table that does not exist in whatever account
 * it was deployed to — and report an empty extraction as the truth. Terraform sets this on the task
 * definition; if it is missing, the deployment is wrong.
 *
 * A function called per use rather than a constant read at module load: `next build` imports every
 * route module to collect its metadata and the build container has none of the runtime's
 * environment, so a throw at load time would fail the build instead of the misconfigured deployment.
 * Same convention as `uploadsTable()` in `src/lib/uploadRecord.ts`.
 *
 * @returns the table name.
 * @throws Error when `NOTICES_TABLE` is unset.
 */
function noticesTable(): string {
  const name = process.env.NOTICES_TABLE;
  if (!name)
    throw new Error(
      "NOTICES_TABLE is not set; the notices table name has to come from the environment",
    );
  return name;
}

function ddb(): DynamoDBClient {
  return new DynamoDBClient({ region: REGION });
}

/**
 * The notice id the hook writes for a document.
 *
 * @param objectKey - the document pipeline's object key.
 * @returns the notice row's partition key.
 */
export function noticeIdFor(objectKey: string): string {
  return `idp-${objectKey}`;
}

/**
 * Only the attributes this read needs.
 *
 * `notice_id` is in the projection although the caller already knows it: it is the key, so it is
 * always present, which is what makes "the row exists" distinguishable from "the row exists and
 * carries no extraction". Without it a row carrying no sections would project to nothing and read as
 * a document recon has never heard of.
 *
 * `record_kind` and `notice_failure_reason` are here for `unavailableReason`. A projection that omits
 * them cannot tell a tracking-only row from a notice, and the branch that reports the row's own
 * reason would then be unreachable — silently, because a projected-away attribute is indistinguishable
 * from an absent one. Dropping either from this list is the one edit to this file that breaks it
 * without breaking anything that looks like it should fail.
 */
const PROJECTION =
  "notice_id, record_kind, notice_failure_reason, idp_sections, idp_sections_omitted";

/** What a projected notice row looks like once unmarshalled. */
interface NoticeRow {
  notice_id: string;
  /**
   * `"notice"` | `"document"` | ABSENT, where ABSENT means `"notice"`.
   *
   * ⚠️ The default is a fact about the data, not a convenience: every row written before the
   * attribute existed has none, and 16 of those are live right now. `unavailableReason` therefore
   * compares against the literal `"document"` and never tests truthiness. The same rule is stated at
   * `DocumentRow.record_kind` in `src/lib/idpDocumentStore.ts` and at `Notice.record_kind` in
   * `backend/recon_core/notices.py`.
   */
  record_kind?: unknown;
  /**
   * Why recon mapped no notice out of the document, as `backend/idp_hook/handler.py` recorded it.
   * Only ever present on a `record_kind == "document"` row.
   */
  notice_failure_reason?: unknown;
  idp_sections?: unknown;
  idp_sections_omitted?: unknown;
}

/**
 * Why a row that exists carries no per-field detail, or null when it does carry some.
 *
 * Both readers below go through here, so the table's `failed` map and the detail panel's
 * `unavailable` can never disagree about the same row. Three answers, and each is read from what the
 * row SAYS rather than guessed from what it is missing:
 *
 *   - the hook had the detail and dropped it to keep the row inside DynamoDB's item limit, storing
 *     the sentence that says so;
 *   - the row is tracking-only (`record_kind == "document"`): the pipeline finished the document but
 *     recon mapped no notice out of it, and the row records why. There was never any per-field detail
 *     to drop, so the reason is the row's own and nothing is inferred;
 *   - anything else is a notice row with no `idp_sections`, which is stated plainly and WITHOUT a
 *     cause, because the row carries nothing that names one.
 *
 * ⚠️ There was a fourth, and it is gone rather than reordered: an `idp_sections === undefined` row
 * used to be told it "was extracted before recon stored per-field detail on the row … re-uploading
 * the document produces a notice that has it". Written for rows predating a 2026-09-08 change, it was
 * false on the only row in the live table that ever reached it — the tracking row above, whose
 * document the pipeline had finished that same day and whose re-upload yields the same unmappable
 * document, so the advice sent the operator to do work that cannot help. It was also dead as a
 * migration message: all 28 notices carry `idp_sections`, and `infra/modules/notice-store/main.tf`
 * records that this table is deliberately never seeded, so a fresh deployment starts empty and can
 * never hold a pre-2026-09-08 row. Reordering it below the tracking check would have left a guessed
 * cause as the default for every other sectionless row; do not reinstate it.
 *
 * @param row - the projected notice row.
 * @returns the reason to show the operator, or null.
 */
function unavailableReason(row: NoticeRow): string | null {
  // The hook dropped the detail to keep the row under DynamoDB's item limit, and said so. The stored
  // sentence names the sizes, so it is shown rather than paraphrased.
  if (typeof row.idp_sections_omitted === "string")
    return row.idp_sections_omitted;
  // A tracking-only row. Compared against the literal because ABSENT means `"notice"` -- a truthiness
  // test here would call every one of the 16 attribute-less live rows a document.
  if (row.record_kind === "document") {
    if (
      typeof row.notice_failure_reason === "string" &&
      row.notice_failure_reason !== ""
    )
      // The row's own sentence, prefixed with only the subject it lacks: unlike the detail panel, the
      // table renders this as one line with no surrounding prose to supply one, and a bare "extracted
      // no notice_date" beside a filename does not say who failed to do what. `_failure_reason` in
      // `backend/idp_hook/handler.py` guarantees the stored half is non-blank.
      return `recon mapped no notice from this document: ${row.notice_failure_reason}`;
    // Only reachable if something other than that hook wrote the row. Says what is known and stops,
    // rather than supplying a cause on the row's behalf.
    return "recon mapped no notice from this document and recorded no reason for it";
  }
  // A notice row with no `idp_sections` attribute at all. Stated, not explained -- see the docstring
  // for the explanation that used to live here and why guessing was worse than admitting.
  if (row.idp_sections === undefined)
    return "recon has no per-field detail stored for this document";
  return null;
}

/**
 * Coerce one stored section into the shape the panel renders.
 *
 * Every field is read explicitly rather than spread, so a row written by an older or a different
 * writer produces a named failure here instead of a panel of `undefined`s.
 *
 * @param raw - one entry of the row's `idp_sections`.
 * @returns the section.
 * @throws Error when the entry is not a record.
 */
function toSection(raw: unknown): ExtractedSection {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("a stored extraction section is not a record");
  const rec = raw as Record<string, unknown>;
  return {
    section_id: typeof rec.section_id === "string" ? rec.section_id : null,
    classification:
      typeof rec.classification === "string" ? rec.classification : null,
    page_ids: Array.isArray(rec.page_ids)
      ? rec.page_ids.filter((p): p is number => typeof p === "number")
      : [],
    fields:
      rec.fields !== null &&
      typeof rec.fields === "object" &&
      !Array.isArray(rec.fields)
        ? (rec.fields as Record<string, unknown>)
        : {},
    confidences: Array.isArray(rec.confidences)
      ? rec.confidences.map(toConfidence)
      : [],
    // Null, never 0: "no confidence was resolved" and "confidence zero" are different readings, and
    // the panel shows the first as an em dash.
    mean_confidence:
      typeof rec.mean_confidence === "number" ? rec.mean_confidence : null,
    alert_count: typeof rec.alert_count === "number" ? rec.alert_count : 0,
  };
}

/**
 * Coerce one stored confidence record.
 *
 * @param raw - one entry of a section's `confidences`.
 * @returns the record.
 * @throws Error when the entry is not a record.
 */
function toConfidence(raw: unknown): ExtractedFieldConfidence {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("a stored field confidence is not a record");
  const rec = raw as Record<string, unknown>;
  return {
    field: typeof rec.field === "string" ? rec.field : "",
    confidence: typeof rec.confidence === "number" ? rec.confidence : 0,
    threshold: typeof rec.threshold === "number" ? rec.threshold : null,
    extracted: rec.extracted === true,
    value: rec.value,
  };
}

/**
 * Turn a projected row into the extraction the routes answer with.
 *
 * @param row - the projected notice row.
 * @returns the sections, or an empty list with the reason there are none.
 */
function toExtraction(row: NoticeRow): NoticeExtraction {
  const unavailable = unavailableReason(row);
  if (unavailable) return { sections: [], unavailable };
  const stored = Array.isArray(row.idp_sections) ? row.idp_sections : [];
  return { sections: stored.map(toSection), unavailable: null };
}

/**
 * Read one document's extraction off its notice row.
 *
 * @param params.objectKey - the document pipeline's object key.
 * @returns the sections, or the reason the row carries none.
 * @throws UnknownDocumentError when recon has no notice for the key.
 */
export async function readNoticeExtraction({
  objectKey,
}: {
  objectKey: string;
}): Promise<NoticeExtraction> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: noticesTable(),
      Key: marshall({ notice_id: noticeIdFor(objectKey) }),
      ProjectionExpression: PROJECTION,
    }),
  );
  if (!resp.Item)
    throw new UnknownDocumentError(
      `recon has no notice for object key ${objectKey}`,
    );
  return toExtraction(unmarshall(resp.Item) as NoticeRow);
}

/** BatchGetItem's hard ceiling on keys per request. */
const BATCH_LIMIT = 100;

/**
 * Read many documents' extractions in as few round trips as DynamoDB allows.
 *
 * A key that cannot be answered is reported against that key rather than failing the call: one
 * document with no notice must not cost the operator the rest of the page.
 *
 * @param params.objectKeys - the document pipeline's object keys.
 * @returns `extractions` keyed by object key, and `failed` carrying a reason per key that has none.
 */
export async function readNoticeExtractions({
  objectKeys,
}: {
  objectKeys: string[];
}): Promise<{
  extractions: Record<string, ExtractedSection[]>;
  failed: Record<string, string>;
}> {
  const extractions: Record<string, ExtractedSection[]> = {};
  const failed: Record<string, string> = {};
  if (objectKeys.length === 0) return { extractions, failed };

  const table = noticesTable();
  const client = ddb();
  // The notice id is derived, so the answer has to be mapped back to the key the caller asked about.
  const keyByNoticeId = new Map(
    objectKeys.map((objectKey) => [noticeIdFor(objectKey), objectKey]),
  );

  for (let start = 0; start < objectKeys.length; start += BATCH_LIMIT) {
    const chunk = objectKeys.slice(start, start + BATCH_LIMIT);
    let keys = chunk.map((objectKey) =>
      marshall({ notice_id: noticeIdFor(objectKey) }),
    );
    const seen = new Set<string>();
    // Twice at most. DynamoDB returns UnprocessedKeys on throttling or when a response would exceed
    // 16 MB, and one retry is enough for a table this size -- but a key still unprocessed after it is
    // REPORTED rather than dropped, because a silently missing row reads as a document that was
    // never extracted.
    for (let attempt = 0; attempt < 2 && keys.length > 0; attempt += 1) {
      const resp = await client.send(
        new BatchGetItemCommand({
          RequestItems: {
            [table]: { Keys: keys, ProjectionExpression: PROJECTION },
          },
        }),
      );
      for (const item of resp.Responses?.[table] ?? []) {
        const row = unmarshall(item) as NoticeRow;
        const objectKey = keyByNoticeId.get(row.notice_id);
        if (objectKey === undefined) continue; // not a key this call asked for
        seen.add(objectKey);
        const extraction = toExtraction(row);
        if (extraction.unavailable) failed[objectKey] = extraction.unavailable;
        else extractions[objectKey] = extraction.sections;
      }
      keys = resp.UnprocessedKeys?.[table]?.Keys ?? [];
    }
    for (const rawKey of keys) {
      const noticeId = rawKey.notice_id?.S;
      const objectKey =
        noticeId === undefined ? undefined : keyByNoticeId.get(noticeId);
      if (objectKey !== undefined)
        failed[objectKey] =
          "the notices table did not answer for this document; try again";
    }
    // Anything neither returned nor left unprocessed has no row at all.
    for (const objectKey of chunk) {
      if (!seen.has(objectKey) && failed[objectKey] === undefined)
        failed[objectKey] = "recon has no notice for this document";
    }
  }

  return { extractions, failed };
}

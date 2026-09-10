/**
 * The Documents tab's reader: recon's OWN notice rows, not the document pipeline's GraphQL API.
 *
 * Server-side only. Every route under `/api/recon/idp-documents/` used to sign a `listDocuments` or
 * `getDocument` call against the extraction pipeline's AppSync API. It reads this table instead,
 * because the IDP post-processing hook already writes everything those queries returned onto the
 * notice row at ingest (`idp_tracking`, `idp_sections`, and the `idp_record`/`idp_started_at` GSI
 * keys) — see `backend/idp_hook/tracking.py` and `backend/recon_core/notices.py`.
 *
 * Two reasons that is a better read than the one it replaces:
 *
 *   - `appsync:GraphQL` is authorised per FIELD, so a grant on somebody else's API can only ever be
 *     verified by the principal that will make the call. `src/lib/noticeExtraction.ts` documents how
 *     that bit us: the deployed console got a 401 for a field nobody had granted.
 *   - a GraphQL failure arrives as HTTP 200 with an `errors` array, so every mistake in that layer
 *     surfaced as "no documents" rather than as an error. A DynamoDB refusal throws.
 *
 * The wire contract the routes answer with is still PascalCase — it was the retiring GraphQL schema's
 * spelling, and keeping it made the change of SOURCE reviewable on its own, without a diff to the page
 * mixed into it. This module owns the translation from the stored snake_case attributes to that
 * contract, in one place, so the two routes cannot disagree.
 *
 * The two fields recon added rather than inherited keep their stored snake_case names, because they are
 * recon's own facts about a row and not the pipeline's: `notice_failure_reason` (why a document produced
 * no notice) and `idp_started_at_approximate` (the listed timestamp was derived, not observed).
 *
 * Rows are keyed `idp-<ObjectKey>` — the same derivation `noticeIdFor` already owns, imported rather
 * than repeated.
 */

import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { noticeIdFor, UnknownDocumentError } from "@/lib/noticeExtraction";
import type {
  IdpConfidenceAlert,
  IdpDocument,
  IdpDocumentDetail,
  IdpDocumentSection,
} from "@/lib/reconApi";

const REGION = process.env.AWS_REGION ?? "us-east-1";

/** The GSI the list route pages over: hash `idp_record`, range `idp_started_at`. */
export const DOCUMENT_INDEX = "idp-document-index";

/** The constant hash-key value every indexed row carries. See `_idp_gsi_attrs` in `notices.py`. */
export const DOCUMENT_INDEX_HASH = "document";

/**
 * The notices table's name, with no fallback on purpose.
 *
 * A default would let this read the wrong table — or one that does not exist in the account it was
 * deployed to — and report an empty Documents tab as the truth.
 *
 * A function called per use rather than a constant read at module load: `next build` imports every
 * route module to collect its metadata and the build container has none of the runtime's
 * environment, so a throw at load time would fail the BUILD instead of the misconfigured deployment.
 * Same convention, and the same table, as `noticesTable()` in `src/lib/noticeExtraction.ts`.
 *
 * @returns the table name.
 * @throws Error when `NOTICES_TABLE` is unset.
 */
export function documentsTable(): string {
  const name = process.env.NOTICES_TABLE;
  if (!name)
    throw new Error(
      "NOTICES_TABLE is not set; the notices table name has to come from the environment",
    );
  return name;
}

/**
 * A DynamoDB client for one call.
 *
 * @returns the client.
 */
function ddb(): DynamoDBClient {
  return new DynamoDBClient({ region: REGION });
}

/**
 * One row of the notices table as this reader consumes it.
 *
 * Deliberately loose: every attribute is optional because the hook writes what the pipeline
 * reported and omits what it did not, and `unknown` on the numerics because DynamoDB hands numbers
 * back as `Decimal`-like values rather than JS numbers (see `num`).
 */
export interface DocumentRow {
  notice_id?: string;
  /**
   * `"notice"` | `"document"` | ABSENT, where ABSENT means `"notice"`.
   *
   * ⚠️ That default is a fact about the data, not a convenience: every row written before the
   * attribute existed has none, and 16 of those are live in this deployment right now. Nothing in the
   * console branches on it — the source route gates on `parse_method` instead, precisely so a
   * tracking-only row keeps its viewable PDF — so it is documented here rather than read. The Python
   * side states the same rule at `Notice.record_kind` in `backend/recon_core/notices.py`.
   */
  record_kind?: string;
  source_document?: string;
  parse_method?: string;
  confidence_alert_count?: unknown;
  notice_failure_reason?: string;
  idp_execution_arn?: string;
  /** The document index's range key, and this reader's fallback start time. See `toIdpDocument`. */
  idp_started_at?: string;
  idp_started_at_approximate?: unknown;
  idp_sections?: unknown;
  idp_tracking?: unknown;
}

/**
 * A stored value as a display string, or null.
 *
 * The empty string collapses to null on purpose. Absence is a fact throughout this data — "the
 * pipeline did not report this" — and the wire contract expresses it as null, so a `""` that reached
 * the page would render as a present-but-blank field. `idp_execution_arn` is the one attribute the
 * hook genuinely stores as `""` when it has no value (see `_document_record`), and it needs exactly
 * this treatment.
 *
 * @param value - the stored attribute value.
 * @returns the string, or null when it is absent, not a string, or empty.
 */
function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A stored numeric as a JS `number`, or null.
 *
 * ⚠️ Required, not cosmetic. `unmarshall` hands numbers back as `Decimal`-like values, and a route
 * that passed one straight into `NextResponse.json` would serialise an OBJECT where the response
 * type promises a number — which the page renders as `[object Object]` and, where it calls
 * `.toFixed(2)`, throws on.
 *
 * Null and never 0 when the value is absent: 0 is a meaningful confidence and a meaningful alert
 * count ("checked, nothing flagged"), so manufacturing one would assert something nobody measured.
 *
 * @param value - the stored attribute value.
 * @returns the number, or null when it is absent or not numeric.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // `Number` over a Decimal-like: `NumberValue.valueOf()` yields its string form, which coerces.
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The row's `idp_tracking` map, or an empty one.
 *
 * An empty map rather than a throw: a notice written before the hook captured a snapshot has no
 * `idp_tracking` at all, and every field read out of it is independently nullable, so the whole row
 * degrades to nulls instead of failing the page.
 *
 * @param row - the unmarshalled notice row.
 * @returns the tracking map.
 */
function tracking(row: DocumentRow): Record<string, unknown> {
  const raw = row.idp_tracking;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * One row as the Documents tab's table consumes it.
 *
 * Every field is read explicitly rather than spread, so a row written by an older writer produces
 * nulls in named places instead of a table of `undefined`s.
 *
 * @param row - the unmarshalled notice row.
 * @returns the PascalCase document row.
 */
export function toIdpDocument(row: DocumentRow): IdpDocument {
  const t = tracking(row);
  return {
    // From what recon RECORDED, not from the row's key. The two are equal by construction, and this
    // is the half that the source route also resolves its S3 key from.
    ObjectKey: str(row.source_document),
    ObjectStatus: str(t.object_status),
    WorkflowStatus: str(t.workflow_status),
    // The snapshot's own time when there is one, and the row's top-level `idp_started_at` when there is
    // not. The fallback is not a guess: `idp_started_at` is the GSI's RANGE key, so it is the value the
    // list route ordered this row by, and showing it is what makes the row's position in the table
    // explainable at all. It is also the value the `≈` marker qualifies — the 16 rows
    // `scripts/backfill_idp_document_index.py` put into the index carry no `idp_tracking` whatsoever, so
    // without this the marker annotated an em dash on exactly the rows it exists for.
    //
    // The tracking snapshot wins where both exist, because it is the time the pipeline OBSERVED; a
    // backfilled `idp_started_at` was derived from the notice's business date.
    //
    // ⚠️ The timestamp is the only field with a legitimate top-level source. `ConfigVersion`,
    // `ObjectStatus`, `PageCount` and `EvaluationStatus` stay null on such a row: recon holds no
    // second-hand version of any of them, and inventing one would assert something nobody recorded.
    InitialEventTime: str(t.initial_event_time) ?? str(row.idp_started_at),
    QueuedTime: str(t.queued_time),
    CompletionTime: str(t.completion_time),
    ConfigVersion: str(t.config_version),
    EvaluationStatus: str(t.evaluation_status),
    PageCount: num(t.page_count),
    // Top-level, not out of `idp_tracking`: this is recon's OWN count, computed by
    // `backend/idp_hook/explainability.py` at ingest, and it is the number the gateway
    // interceptor's write refusal is scored on. IDP's own ConfidenceAlertCount was null on every
    // live document, which is why the column reads this instead.
    ConfidenceAlertCount: num(row.confidence_alert_count),
    // Only on a `record_kind == "document"` row. Carried so the tab can say WHY a document produced
    // no notice instead of showing an empty row.
    notice_failure_reason: str(row.notice_failure_reason),
    // A plain boolean, unlike everything above, because absence has a definite meaning here rather
    // than being a gap: `scripts/backfill_idp_document_index.py` sets this only on the rows whose
    // `idp_started_at` it derived from `notice_date`, so no attribute means a real ingest time.
    idp_started_at_approximate: row.idp_started_at_approximate === true,
    // No human-review fields, on purpose. The IDP completion event carries none at all, so recon has
    // none to store — and the page no longer has a renderer that would ask for one. See the note above
    // `IdpDocument` in `src/lib/reconApi.ts` for why they are absent rather than typed `null`.
  };
}

/**
 * One per-attribute confidence alert, as the detail panel consumes it.
 *
 * ⚠️ The stored keys are snake_case (`attribute_name`, `confidence_threshold`) and the wire contract
 * is camelCase (`attributeName`, `confidenceThreshold`), because the contract is the retiring AppSync
 * schema's and the page reads those names directly. The translation is explicit for that reason: a
 * spread here would compile, ship, and render `undefined — undefined below undefined`, and the
 * `.toFixed(2)` calls on the page would throw. Do NOT "simplify" this into a spread while the page
 * still reads camelCase.
 *
 * The VALUES are verbatim. Nothing in this module compares a confidence to a threshold or derives an
 * alert: `backend/idp_hook/tracking.py`'s `_sections_meta` stores the pipeline's own numbers
 * precisely so the console never recomputes them, and a second implementation could disagree with the
 * count shown above the row.
 *
 * @param raw - one entry of a section's stored `confidence_threshold_alerts`.
 * @returns the alert.
 */
function toAlert(raw: unknown): IdpConfidenceAlert {
  const rec =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    attributeName: str(rec.attribute_name),
    confidence: num(rec.confidence),
    confidenceThreshold: num(rec.confidence_threshold),
  };
}

/**
 * The alerts stored against one `sections_meta` entry.
 *
 * An absent `confidence_threshold_alerts` yields null rather than `[]`: `_sections_meta` omits the
 * key when the pipeline reported no such field at all, which is a different statement from "the
 * pipeline checked and flagged nothing".
 *
 * @param meta - one `idp_tracking.sections_meta` entry, or undefined when the section has none.
 * @returns the alerts, or null.
 */
function alertsOf(
  meta: Record<string, unknown> | undefined,
): IdpConfidenceAlert[] | null {
  const raw = meta?.confidence_threshold_alerts;
  if (!Array.isArray(raw)) return null;
  return raw.map(toAlert);
}

/**
 * Index `idp_tracking.sections_meta` by section id.
 *
 * @param row - the unmarshalled notice row.
 * @returns a lookup from section id to its meta entry, in stored order.
 */
function sectionsMetaById(
  row: DocumentRow,
): Map<string, Record<string, unknown>> {
  const raw = tracking(row).sections_meta;
  const out = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const rec = entry as Record<string, unknown>;
    out.set(String(rec.section_id ?? ""), rec);
  }
  return out;
}

/**
 * Join the row's two per-section sources into the sections the detail panel renders.
 *
 * `idp_sections` carries what was extracted (id, classification, pages) and
 * `idp_tracking.sections_meta` carries the pipeline's alerts, joined on `section_id`. It is an OUTER
 * join on purpose: `idp_sections` is the one attribute the writer drops to keep an oversized row
 * under DynamoDB's item limit (see `_fit_item`), so a section can legitimately exist in the meta and
 * nowhere else — and dropping it would hide the very alerts an operator opened the panel for.
 *
 * @param row - the unmarshalled notice row.
 * @returns one entry per section known to either source, extracted sections first.
 */
function toSections(row: DocumentRow): IdpDocumentSection[] {
  const meta = sectionsMetaById(row);
  const seen = new Set<string>();
  const out: IdpDocumentSection[] = [];

  const stored = Array.isArray(row.idp_sections) ? row.idp_sections : [];
  for (const entry of stored) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      continue;
    const rec = entry as Record<string, unknown>;
    const id = String(rec.section_id ?? "");
    seen.add(id);
    out.push({
      Id: str(rec.section_id),
      Class: str(rec.classification),
      PageIds: Array.isArray(rec.page_ids)
        ? rec.page_ids.map(num).filter((p): p is number => p !== null)
        : null,
      ConfidenceThresholdAlerts: alertsOf(meta.get(id)),
      // --- Frozen wire contract, always null ----------------------------------------------------
      // IDP's section-exclusion flags are absent from the completion event, so recon stores neither.
      // Kept on the contract because the panel still reads them, and reading them costs nothing: it
      // renders an exclusion note only when the flag is TRUE, so a null says nothing at all.
      Excluded: null,
      ExclusionReason: null,
    });
  }

  // Sections the meta knows about and the extraction does not.
  for (const [id, rec] of meta) {
    if (seen.has(id)) continue;
    out.push({
      Id: str(rec.section_id),
      Class: null,
      PageIds: null,
      ConfidenceThresholdAlerts: alertsOf(rec),
      Excluded: null,
      ExclusionReason: null,
    });
  }

  return out;
}

/**
 * One row in full, as the Documents tab's detail panel consumes it.
 *
 * @param row - the unmarshalled notice row.
 * @returns the PascalCase document detail.
 */
export function toIdpDocumentDetail(row: DocumentRow): IdpDocumentDetail {
  const t = tracking(row);
  return {
    ...toIdpDocument(row),
    WorkflowExecutionArn: str(row.idp_execution_arn),
    Sections: toSections(row),
    // Pointers into the pipeline's own report objects. `summary_report_uri` is present only when the
    // pipeline supplied one, which is why both are read the same nullable way.
    EvaluationReportURI: str(t.evaluation_report_uri),
    SummaryReportURI: str(t.summary_report_uri),
  };
}

/**
 * Read one document's row by object key.
 *
 * The whole item, with no projection expression: the detail response reads a dozen top-level
 * attributes plus two nested maps, and a projection listing them all would have to escape the
 * reserved words among them for no saving on a single-item read.
 *
 * @param params.objectKey - the document pipeline's object key.
 * @returns the unmarshalled row.
 * @throws UnknownDocumentError when recon has no row for the key.
 */
export async function readDocumentRow({
  objectKey,
}: {
  objectKey: string;
}): Promise<DocumentRow> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: documentsTable(),
      Key: marshall({ notice_id: noticeIdFor(objectKey) }),
    }),
  );
  if (!resp.Item)
    throw new UnknownDocumentError(
      `recon has no notice for object key ${objectKey}`,
    );
  return unmarshall(resp.Item) as DocumentRow;
}

/** What recon recorded about where a document's bytes live. */
export interface DocumentSourceRef {
  /** The S3 key recon stored for this document. The key the source route reads. */
  sourceDocument: string | null;
  /** How the row was produced. Only `"IDP"` has a source file behind it. */
  parseMethod: string | null;
}

/**
 * Read only what the source-bytes route needs to resolve a key.
 *
 * A projection rather than the whole row: this is the existence probe in front of a byte stream, and
 * a notice row carries the document's entire extracted content, which the probe has no use for.
 *
 * Deliberately in this module rather than in the route, so DynamoDB access to this table stays in one
 * file and `notice_id`'s derivation stays in one place.
 *
 * @param params.objectKey - the document pipeline's object key.
 * @returns the stored source key and parse method.
 * @throws UnknownDocumentError when recon has no row for the key.
 */
export async function readDocumentSourceRef({
  objectKey,
}: {
  objectKey: string;
}): Promise<DocumentSourceRef> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: documentsTable(),
      Key: marshall({ notice_id: noticeIdFor(objectKey) }),
      ProjectionExpression: "notice_id, source_document, parse_method",
    }),
  );
  if (!resp.Item)
    throw new UnknownDocumentError(
      `recon has no notice for object key ${objectKey}`,
    );
  const row = unmarshall(resp.Item) as DocumentRow;
  return {
    sourceDocument: str(row.source_document),
    parseMethod: str(row.parse_method),
  };
}

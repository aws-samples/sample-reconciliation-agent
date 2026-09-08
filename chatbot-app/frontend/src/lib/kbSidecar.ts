/**
 * The metadata sidecar that makes an uploaded knowledge-base document findable.
 *
 * A Bedrock knowledge base will happily ingest a document with no sidecar. It becomes retrievable
 * and citable and carries no filterable attributes at all -- which means it does not match any
 * `doc_type` or `break_class` filter, and every skill that searches the corpus does so with a
 * filter. The document is therefore present, healthy, and unreachable, and no log line anywhere says
 * so. That failure mode is the reason this module exists and the reason a put without a sidecar is a
 * hard error rather than a degraded result.
 *
 * The envelope is not a design choice, it is a copy. It matches the sidecars under `data/kb-seed/`
 * exactly, because the corpus is one index and a second convention inside it would produce documents
 * that filter differently from their neighbours for no visible reason.
 *
 * Three details in it are counter-intuitive and all three were read off the real files rather than
 * inferred:
 *
 *   - `has_attachments` is a STRING holding "true"/"false". The managed knowledge base silently
 *     DROPS any attribute of type BOOLEAN -- the attribute is simply absent from the indexed
 *     document, with no failure reported. A boolean here would read as correct and filter as absent.
 *   - `sender` is a STRING but `receiver` is a STRING_LIST, because an email has one sender and any
 *     number of recipients, and a list is what a filter can test membership against.
 *   - `skill` is a STRING_LIST with includeForEmbedding FALSE. It is the attribute a skill's own
 *     retrieval filter names, so it decides reachability; embedding it as well would put a tool
 *     name into the vector and pull unrelated documents toward any question that mentions it.
 */

/** The two facets an uploaded document may be. `playbook` is deliberately not one of them. */
export type KbDocType = "email" | "email_attachment";

/** One attribute in the sidecar's envelope. The managed KB accepts these three types only. */
type AttributeValue =
  | { type: "STRING"; stringValue: string }
  | { type: "STRING_LIST"; stringListValue: string[] }
  | { type: "NUMBER"; numberValue: number };

interface Attribute {
  value: AttributeValue;
  includeForEmbedding: boolean;
}

export interface Sidecar {
  metadataAttributes: Record<string, Attribute>;
}

export interface SidecarInput {
  docType: KbDocType;
  /** Shared across every file in one submission, so a body and its attachments join up. */
  messageId: string;
  subject: string;
  sender?: string;
  receiver?: string[];
  /** ISO-8601. Both `received_date` and `effective_date` are derived from it. */
  receivedDate: string;
  /** Break classes this document is precedent for. Embedded, so it steers retrieval. */
  breakClass?: string[];
  /**
   * Skills whose retrieval should reach this document, e.g. `consult-guidance`.
   *
   * Filtered on, never embedded. Every seeded email and playbook carries this, and a document
   * without it is retrievable only by a search that applies no skill filter -- which is not the
   * search any skill performs.
   */
  skills?: string[];
  /** Body documents only. */
  hasAttachments?: boolean;
  /** Attachment documents only, and required on them. Bare extension, no dot. */
  attachmentFormat?: string;
}

/**
 * Convert an ISO-8601 timestamp to the YYYYMMDD integer the corpus filters on.
 *
 * UTC deliberately: the seeded corpus was generated in UTC, and a local-time reading would put a
 * document on the wrong side of a date filter for half of every day.
 *
 * @param iso - an ISO-8601 timestamp.
 * @returns the date as a YYYYMMDD integer, e.g. 20260902.
 * @throws Error when the string is not a parseable date.
 */
export function yyyymmdd(iso: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`"${iso}" is not a parseable ISO-8601 timestamp`);
  }
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return Number(`${date.getUTCFullYear()}${month}${day}`);
}

/** STRING attribute, or nothing at all when the value is empty. */
function str(value: string | undefined, embed: boolean): Attribute | undefined {
  // An empty string is omitted rather than written, because an attribute present-and-blank matches
  // a filter for the blank value, whereas an absent one matches nothing. Absent is the honest one.
  if (!value) return undefined;
  return {
    value: { type: "STRING", stringValue: value },
    includeForEmbedding: embed,
  };
}

/** STRING_LIST attribute, or nothing at all when the list is empty. */
function list(
  values: string[] | undefined,
  embed: boolean,
): Attribute | undefined {
  if (!values || values.length === 0) return undefined;
  return {
    value: { type: "STRING_LIST", stringListValue: values },
    includeForEmbedding: embed,
  };
}

/**
 * Build the sidecar for one uploaded knowledge-base document.
 *
 * @param input - the document's facet and the email fields it was parsed from.
 * @returns the sidecar, ready to `JSON.stringify` into `<key>.metadata.json`.
 * @throws Error when an `email_attachment` has no `attachmentFormat` -- see below.
 */
export function buildSidecar(input: SidecarInput): Sidecar {
  // Refused rather than defaulted. `attachment_format` is how a skill asks for "the spreadsheet
  // that came with this email"; an attachment missing it is retrievable only by a search that
  // does not filter, which no skill performs.
  if (input.docType === "email_attachment" && !input.attachmentFormat) {
    throw new Error(
      "an email_attachment needs attachment_format — without it no skill's filter can reach it",
    );
  }

  const date = yyyymmdd(input.receivedDate);
  const candidates: Record<string, Attribute | undefined> = {
    doc_type: str(input.docType, false),
    break_class: list(input.breakClass, true),
    // Filtered on, not embedded -- exactly as the seeded corpus writes it. This is the attribute
    // `consult-guidance` names in its retrieval filter, so a document that reaches the index
    // without it is unreachable by the skill that was supposed to find it.
    skill: list(input.skills, false),
    // effective_date and received_date are the same value for an uploaded document and are both
    // written anyway: the corpus's playbooks filter on effective_date and its emails on
    // received_date, and an upload has to be reachable from either.
    effective_date: {
      value: { type: "NUMBER", numberValue: date },
      includeForEmbedding: false,
    },
    received_date: {
      value: { type: "NUMBER", numberValue: date },
      includeForEmbedding: false,
    },
    message_id: str(input.messageId, false),
    sender: str(input.sender, false),
    receiver: list(input.receiver, false),
    subject: str(input.subject, true),
    ...(input.docType === "email_attachment"
      ? { attachment_format: str(input.attachmentFormat, false) }
      : { has_attachments: str(String(Boolean(input.hasAttachments)), false) }),
  };

  const metadataAttributes: Record<string, Attribute> = {};
  for (const [key, attribute] of Object.entries(candidates)) {
    if (attribute) metadataAttributes[key] = attribute;
  }
  return { metadataAttributes };
}

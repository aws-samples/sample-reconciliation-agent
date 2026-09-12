/**
 * Request-body parsers for the `/api/pipeline` routes.
 *
 * Kept out of the route files for two reasons. Next validates a `route.ts`'s exports at build time
 * and rejects anything that is not a handler or a segment config, so helpers that tests need to
 * import cannot live there. And every parser here THROWS a message naming the problem rather than
 * returning a sanitised body: a request that says both `sample_id` and `raw`, or edits `issue_size`
 * instead of `issue_size_mm`, is a client bug that must surface as a 400, not be quietly resolved one
 * way. (The memory delete parser both apps share lives in `lib/server/memoryRequests.ts`.)
 */

import type { FieldValues } from "@/lib/pipeline/types";
import { fieldDef } from "@/lib/pipeline/omsSchema";
import { stringField } from "@/lib/server/http";

// ---------------------------------------------------------------------------------------------
// POST /emails
// ---------------------------------------------------------------------------------------------

/** Either a corpus id or a hand-typed email — exactly one of them. */
export type CreateEmailRequest =
  | { sample_id: string }
  | {
      raw: {
        from: string;
        to?: string;
        cc?: string;
        subject: string;
        body: string;
        sent?: string;
      };
    };

/**
 * Ceiling on a hand-typed email body, in UTF-8 bytes.
 *
 * The email row is a whole DynamoDB item (400 KB hard limit) that carries the body verbatim, and
 * the body is later pasted into the parser's model prompt. 200 KB is several times the longest real
 * deal notice while leaving the item well clear of the limit; past it, PutItem would fail AFTER the
 * S3 copy was written and leave an orphaned object. Measured in bytes, not characters, because the
 * DynamoDB limit is.
 */
export const MAX_EMAIL_BODY_BYTES = 200 * 1024;
/** Ceiling on each header line (`from`, `to`, `cc`, `subject`), in UTF-8 bytes. */
export const MAX_EMAIL_HEADER_BYTES = 1024;

const utf8 = new TextEncoder();

/** UTF-8 length of a string — what DynamoDB and S3 actually count. */
function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** @throws Error when a header field is over `MAX_EMAIL_HEADER_BYTES`. */
function headerField(r: Record<string, unknown>, key: string): string | undefined {
  const value = stringField(r, key);
  if (value !== undefined && byteLength(value) > MAX_EMAIL_HEADER_BYTES) {
    throw new Error(`raw.${key} is longer than ${MAX_EMAIL_HEADER_BYTES} bytes`);
  }
  return value;
}

/**
 * Validate a `POST /emails` body.
 *
 * @throws Error naming the problem. `sample_id` and `raw` are exclusive because a body carrying
 *   both has no single right answer. Oversized fields are refused here, before anything is written.
 */
export function parseCreateEmailBody(body: Record<string, unknown> | null): CreateEmailRequest {
  if (!body) throw new Error("body must be a JSON object");
  const sampleId = stringField(body, "sample_id");
  const raw = body.raw;
  if (sampleId && raw !== undefined) {
    throw new Error("send either sample_id or raw, not both");
  }
  if (sampleId) return { sample_id: sampleId };
  if (raw === undefined) throw new Error("sample_id or raw is required");
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("raw must be an object with from, subject and body");
  }
  const r = raw as Record<string, unknown>;
  const from = headerField(r, "from");
  const subject = headerField(r, "subject");
  const text = stringField(r, "body");
  if (!from || !subject || !text) {
    throw new Error("raw.from, raw.subject and raw.body are required");
  }
  if (byteLength(text) > MAX_EMAIL_BODY_BYTES) {
    throw new Error(`raw.body is larger than ${MAX_EMAIL_BODY_BYTES / 1024} KB`);
  }
  const sent = stringField(r, "sent");
  if (sent && Number.isNaN(Date.parse(sent))) {
    throw new Error("raw.sent must be an ISO-8601 timestamp");
  }
  return {
    raw: {
      from,
      to: headerField(r, "to"),
      cc: headerField(r, "cc"),
      subject,
      body: text,
      sent,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PATCH /deals/[id]
// ---------------------------------------------------------------------------------------------

/**
 * The `fields` a PATCH carries: a partial map of known field keys to string values.
 *
 * Unknown keys and non-string values are refused rather than dropped. A client that sends
 * `issue_size` for `issue_size_mm` would otherwise get a 200 and a CSV that did not change.
 *
 * @throws Error naming the problem.
 */
export function parseFieldsBody(body: Record<string, unknown> | null): Partial<FieldValues> {
  const fields = body?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("body must be { fields: { <field_key>: string } }");
  }
  const out: Partial<FieldValues> = {};
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (!fieldDef(key)) throw new Error(`unknown field key "${key}"`);
    if (typeof value !== "string") throw new Error(`field "${key}" must be a string`);
    out[key] = value.trim();
  }
  if (Object.keys(out).length === 0) throw new Error("fields is empty");
  return out;
}

// ---------------------------------------------------------------------------------------------
// POST /chat
// ---------------------------------------------------------------------------------------------

/** Chat sessions are memory session ids, so they carry the character set the memory API accepts. */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** Generous for a chat box, small enough that a runaway client cannot post a novel per turn. */
const MAX_MESSAGE_CHARS = 8000;

export interface ChatRequest {
  session_id: string;
  message: string;
  context?: { deal_id?: string; email_id?: string };
}

/**
 * Validate a `POST /chat` body before any stream is opened.
 *
 * @throws Error naming the problem.
 */
export function parseChatBody(body: Record<string, unknown> | null): ChatRequest {
  if (!body) throw new Error("body must be a JSON object");
  const sessionId = stringField(body, "session_id");
  if (!sessionId || !SESSION_ID.test(sessionId)) {
    throw new Error("session_id is required and must match [A-Za-z0-9_-]{1,100}");
  }
  const message = stringField(body, "message");
  if (!message) throw new Error("message is required");
  if (message.length > MAX_MESSAGE_CHARS) {
    throw new Error(`message is longer than ${MAX_MESSAGE_CHARS} characters`);
  }
  const rawContext = body.context;
  let context: ChatRequest["context"];
  if (rawContext !== undefined) {
    if (!rawContext || typeof rawContext !== "object" || Array.isArray(rawContext)) {
      throw new Error("context must be an object");
    }
    const c = rawContext as Record<string, unknown>;
    context = { deal_id: stringField(c, "deal_id"), email_id: stringField(c, "email_id") };
  }
  return { session_id: sessionId, message, context };
}

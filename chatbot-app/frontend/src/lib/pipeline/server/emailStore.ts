/**
 * Emails table (design §4) plus the raw-email copy in S3.
 *
 * The BFF creates emails and flips them to PARSING; the parser Lambda owns every other transition
 * (PARSED / PARSE_FAILED, `parse`, `deal_id`). Writes here are whole-item puts of a record the BFF
 * has just read or built. On the create path that is safe because the parser is only invoked after
 * the BFF's write. Reparse is different: a second tab or a stale poll can post it while a parser
 * run is already in flight, so `markParsing` is a conditional write that refuses to start a second
 * run — two concurrent runs would each mint a deal and race on this row, leaving one deal orphaned.
 */

import type { EmailRecord, SourceKind } from "@/lib/pipeline/types";
import { getItem, putItem, putText, scanAll } from "./aws";
import { env } from "./env";
import { newEmailId } from "./ids";

/** What a caller must supply to create an email; everything else is derived. */
export interface NewEmailInput {
  source_kind: SourceKind;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  sent: string;
  body: string;
  sample_id: string | null;
}

/** S3 key of the raw email JSON, per the design's bucket layout. */
export function emailObjectKey(emailId: string): string {
  return `emails/${emailId}.json`;
}

/** Every email, newest received first. */
export async function listEmails(): Promise<EmailRecord[]> {
  const items = await scanAll<EmailRecord>(env.emailsTable());
  return items.sort((a, b) => b.received_at.localeCompare(a.received_at));
}

export async function getEmail(emailId: string): Promise<EmailRecord | null> {
  return getItem<EmailRecord>(env.emailsTable(), { email_id: emailId });
}

export async function putEmail(email: EmailRecord): Promise<void> {
  await putItem(env.emailsTable(), email);
}

/**
 * Create a RECEIVED email: the DynamoDB record and the raw JSON copy in S3.
 *
 * The S3 copy is written first. It is the input the parser reads back if it ever needs the
 * untouched message, and writing it second would leave a window where the row exists, the parser
 * has been invoked, and the object is not there yet.
 */
export async function createEmail(
  input: NewEmailInput,
  now: Date = new Date(),
): Promise<EmailRecord> {
  const receivedAt = now.toISOString();
  const email: EmailRecord = {
    email_id: newEmailId(input.subject, now),
    received_at: receivedAt,
    source_kind: input.source_kind,
    from: input.from,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    sent: input.sent,
    body: input.body,
    sample_id: input.sample_id,
    status: "RECEIVED",
    deal_id: null,
    parse: null,
    error: null,
    updated_at: receivedAt,
  };
  await putText(
    emailObjectKey(email.email_id),
    JSON.stringify(email, null, 2),
    "application/json",
  );
  await putEmail(email);
  return email;
}

/**
 * Mark an email PARSING ahead of (re-)invoking the parser, clearing a previous failure.
 *
 * Conditional on the row not already being PARSING, so two reparse requests that both read a
 * PARSED row cannot both start a parser run: the second put is refused by DynamoDB and the route
 * answers 409. (A missing `status` attribute passes — the create path writes RECEIVED first, so it
 * never arises in practice, and refusing would only strand a malformed row.)
 *
 * Returns the updated record so the route can answer with what it wrote.
 *
 * @throws ConditionalCheckFailedException when a parser run is already in flight for the email.
 */
export async function markParsing(
  email: EmailRecord,
  now: Date = new Date(),
): Promise<EmailRecord> {
  const updated: EmailRecord = {
    ...email,
    status: "PARSING",
    error: null,
    updated_at: now.toISOString(),
  };
  await putItem(env.emailsTable(), updated, {
    expression: "attribute_not_exists(#status) OR #status <> :parsing",
    names: { "#status": "status" },
    values: { ":parsing": "PARSING" },
  });
  return updated;
}

/**
 * Record that the parser could not even be invoked.
 *
 * Distinct from the parser's own PARSE_FAILED: that one carries a model or validation error, this
 * one means the Lambda was never reached (wrong function name, missing permission). Both land on
 * the same status because the Inbox's remedy — read the error, fix, reparse — is the same.
 */
export async function markInvokeFailed(
  email: EmailRecord,
  reason: string,
  now: Date = new Date(),
): Promise<EmailRecord> {
  const updated: EmailRecord = {
    ...email,
    status: "PARSE_FAILED",
    error: `parser invoke failed: ${reason}`,
    updated_at: now.toISOString(),
  };
  await putEmail(updated);
  return updated;
}

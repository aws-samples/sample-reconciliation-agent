/**
 * The operator-owned recipients table (`recon-contacts`), in two clearly separated halves.
 *
 * The SEND half is {@link resolveContactAddress} and nothing else: it is the only function here that
 * turns an id into an address, and it refuses rather than falling back. The OPERATOR half below it
 * reads and writes whole rows for the Config tab. They are in one file because they must agree about
 * what a contact is, and separated by a banner because they answer to different audiences — one is on
 * the path of an outgoing email, the other is a form.
 *
 * The BFF resolves a `contact_id` to an address in two unrelated places, and neither of them is a
 * security boundary: the draft route resolves to VALIDATE (so an analyst gets a 400 now instead of a
 * gateway denial after they have already approved something), and the send path resolves to know
 * where to address the mail. The gateway interceptor resolves the same id independently, from the
 * same table, and its answer is the one that decides whether the send happens. Two resolutions of one
 * id is deliberate — the interceptor's verdict must not depend on this file being correct.
 *
 * Every read hits DynamoDB. No cache, at any TTL: a cached address keeps a deactivated recipient
 * reachable for the length of the TTL, and that window is the entire thing deactivation exists to
 * close.
 *
 * The refusals below mirror `backend/contacts/store.py`'s `resolve_address` — same three causes, same
 * shape of message. They are a courtesy here (a readable 400 rather than an opaque one), so a drift
 * between the two is a UX bug, not a hole.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const CONTACTS_TABLE = process.env.CONTACTS_TABLE ?? "recon-dev-contacts";

/** What a contact may be used for. A contact of one kind can never satisfy a send of the other. */
export type ContactKind = "counterparty" | "internal_notification";

/**
 * The two kinds, as data, for validating an operator's input.
 *
 * Mirrors `CONTACT_KINDS` in `backend/contacts/store.py`. A third kind added on one side only would
 * store rows that every reader on the other side treats as unsendable — so the two lists are the same
 * list, and adding to one means adding to the other.
 */
export const CONTACT_KINDS: readonly ContactKind[] = [
  "counterparty",
  "internal_notification",
];

/** A stored contact row. `email` is present here because this module is the operator-side reader. */
export interface Contact {
  contact_id: string;
  display_name: string;
  email: string;
  kind: ContactKind;
  active: boolean;
  /** Provenance. Never rewritten by an edit — who ADDED a recipient is the interesting question. */
  created_by?: string;
  created_at?: string;
  updated_by?: string;
  updated_at?: string;
}

/** No active contact of the requested kind answers to this id. Distinct from a read failure. */
export class ContactUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactUnavailable";
  }
}

function ddb() {
  return new DynamoDBClient({ region: REGION });
}

/**
 * The email address of one active contact of the given kind.
 *
 * @param contactId - the id the draft cites, or the one the analyst just picked.
 * @param kind - what the send is for; a contact of another kind cannot satisfy it.
 * @returns the contact's address.
 * @throws ContactUnavailable when the id is unknown, the contact is deactivated, its kind does not
 *   match, or it carries no address. All four are refusals rather than fallbacks — falling back to
 *   anything at all here would mean an address nobody chose ends up on an outgoing message.
 */
export async function resolveContactAddress({
  contactId,
  kind,
}: {
  contactId: string;
  kind: ContactKind;
}): Promise<string> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: CONTACTS_TABLE,
      Key: { contact_id: { S: contactId } },
    }),
  );
  if (!resp.Item)
    throw new ContactUnavailable(`contact ${contactId} does not exist`);
  const row = unmarshall(resp.Item) as Partial<Contact>;
  if (!row.active)
    throw new ContactUnavailable(
      `contact ${contactId} is deactivated and cannot be sent to`,
    );
  if (row.kind !== kind)
    throw new ContactUnavailable(
      `contact ${contactId} has kind ${row.kind}, which cannot satisfy a ${kind} send`,
    );
  if (!row.email)
    throw new ContactUnavailable(
      `contact ${contactId} has no email address stored`,
    );
  return row.email;
}

// ---------------------------------------------------------------------------------------------
// Operator console half. Everything below is reached only from `api/recon/config/contacts/*`, which
// is the ONLY write path onto this table in the whole deployment — the agent's gateway tool is
// read-only and projects `email` away, and no Lambda role carries PutItem. These functions therefore
// see the full row, addresses included, and that is correct for the audience: an operator editing
// their own recipient list.
// ---------------------------------------------------------------------------------------------

/** An operator's input was refused. Distinct from a DynamoDB failure so the route can answer 400. */
export class ContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactValidationError";
  }
}

/** Current UTC time in the second-resolution ISO form the rest of the recon tables use. */
export function nowStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * Scan a whole table, following the pagination token.
 *
 * These tables hold tens of rows, so one page is the norm — but an unfollowed `LastEvaluatedKey` is a
 * silent truncation, and the symptom is one recipient mysteriously missing from the Config tab once
 * the list grows. Exported because the templates table needs exactly the same loop.
 *
 * @param table - the table name to scan.
 * @returns every item, unmarshalled.
 */
export async function scanAll(
  table: string,
): Promise<Record<string, unknown>[]> {
  const client = ddb();
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined = undefined;
  for (;;) {
    const resp = await client.send(
      new ScanCommand({
        TableName: table,
        ...(start ? { ExclusiveStartKey: start as never } : {}),
      }),
    );
    for (const raw of resp.Items ?? []) items.push(unmarshall(raw));
    if (!resp.LastEvaluatedKey) return items;
    start = resp.LastEvaluatedKey as unknown as Record<string, unknown>;
  }
}

/**
 * Every contact, INCLUDING deactivated ones and their addresses.
 *
 * Deactivated rows are returned rather than filtered because the Config tab has to show them: they
 * are why an old draft is unsendable, and a list that hides them turns "this contact was revoked"
 * into "this contact never existed".
 *
 * @returns the raw rows, sorted by display name so the table does not reshuffle between saves.
 */
export async function listContacts(): Promise<Contact[]> {
  const rows = (await scanAll(CONTACTS_TABLE)) as unknown as Contact[];
  return rows.sort((a, b) =>
    (a.display_name ?? "").localeCompare(b.display_name ?? ""),
  );
}

/**
 * Create or replace one contact, stamping the audit attributes.
 *
 * @param contact - must carry `contact_id`, `display_name`, `email` and `kind`. `active` defaults to
 *   true on create and is otherwise preserved unless the caller passes it.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written.
 * @throws ContactValidationError on a missing attribute or an unknown `kind`. Refused rather than
 *   defaulted: a contact stored with the wrong kind is silently unsendable, and the operator finds
 *   out when a case fails to notify rather than when they typed it.
 */
export async function putContact({
  contact,
  actor,
}: {
  contact: Partial<Contact>;
  actor: string;
}): Promise<Contact> {
  for (const key of ["contact_id", "display_name", "email", "kind"] as const) {
    if (!contact[key])
      throw new ContactValidationError(`contact is missing ${key}`);
  }
  if (!CONTACT_KINDS.includes(contact.kind as ContactKind))
    throw new ContactValidationError(
      `contact kind ${contact.kind} is not one of ${CONTACT_KINDS.join(", ")}`,
    );
  const existing = await getContactRow(contact.contact_id!);
  const now = nowStamp();
  const row: Contact = {
    ...(existing ?? {}),
    ...(contact as Contact),
    active: Boolean(contact.active ?? existing?.active ?? true),
    // An edit must not rewrite who added the recipient, so these two survive from the create.
    created_by: existing?.created_by ?? actor,
    created_at: existing?.created_at ?? now,
    updated_by: actor,
    updated_at: now,
  };
  await ddb().send(
    new PutItemCommand({
      TableName: CONTACTS_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

/**
 * Soft-delete one contact by clearing `active`.
 *
 * Never a `DeleteItem`. A hard delete would strand every historical draft citing the id, and the case
 * screen would render a blank recipient with no way to tell whether it was never set or later removed.
 *
 * @param contactId - the contact to deactivate.
 * @param actor - the authenticated principal making the change.
 * @returns the row as written.
 * @throws ContactUnavailable when no such contact exists — deactivating nothing must not read as
 *   success.
 */
export async function deactivateContact({
  contactId,
  actor,
}: {
  contactId: string;
  actor: string;
}): Promise<Contact> {
  const existing = await getContactRow(contactId);
  if (!existing)
    throw new ContactUnavailable(`contact ${contactId} does not exist`);
  const row: Contact = {
    ...existing,
    active: false,
    updated_by: actor,
    updated_at: nowStamp(),
  };
  await ddb().send(
    new PutItemCommand({
      TableName: CONTACTS_TABLE,
      Item: marshall(row, { removeUndefinedValues: true }),
    }),
  );
  return row;
}

/**
 * One raw contact row, or null when the id is unknown.
 *
 * Separate from {@link resolveContactAddress} because the operator path must be able to READ a
 * deactivated or wrong-kind contact in order to edit it, while the send path must refuse to.
 *
 * @param contactId - the partition key.
 * @returns the row, or null.
 */
export async function getContactRow(
  contactId: string,
): Promise<Contact | null> {
  const resp = await ddb().send(
    new GetItemCommand({
      TableName: CONTACTS_TABLE,
      Key: { contact_id: { S: contactId } },
    }),
  );
  return resp.Item ? (unmarshall(resp.Item) as Contact) : null;
}

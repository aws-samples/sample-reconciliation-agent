/**
 * Conditional writes against a case's persisted `proposed_email` draft.
 *
 * Every mutation here is a single conditional `UpdateItem` pinned to the `revision` the caller was
 * looking at, because two analysts on the same case is the normal situation, not the exotic one: one
 * reads the draft, the other edits it, and the first then approves — believing they approved the
 * text on their screen. Read-then-write would let that through. The condition makes the loser fail.
 *
 * The revision is also what the gateway interceptor checks at send time (`approved_revision ==
 * revision`), so these writes and that gate are two ends of the same mechanism: an approval names a
 * specific revision, and only that revision can be sent.
 *
 * A failed condition is reported as a {@link DraftConflict} carrying a message that says which of
 * the several possible reasons it was. Diagnosing costs one extra read, on the failure path only —
 * cheap, and the alternative is an analyst staring at "conflict" with no idea what to do next.
 */

import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const CASES_TABLE = process.env.CASES_TABLE ?? "recon-dev-cases";

/**
 * Draft lifecycle, mirroring `backend/recon_core/email_policy.py`'s DRAFT_* constants.
 *
 * `render_failed` is not an analyst action: the agent cited a template whose placeholders and its
 * payload disagreed, so the draft was persisted visibly broken rather than dropped. It has no approve
 * path — an operator fixes the template, and the case is re-investigated.
 */
export type DraftStatus =
  "pending" | "approved" | "discarded" | "sent" | "render_failed";

/** The `proposed_email` map as `email_policy.build_persisted_draft` writes it. */
export interface PersistedDraft {
  /**
   * Always null, in every persisted row, forever. The address is resolved from
   * `recipient_contact_id` at send time — by the BFF to know where to send, and independently by the
   * gateway interceptor to decide whether to allow. Kept in the type because the attribute is
   * written (as NULL) and code that reads it should see that it is never an address.
   */
  recipient: null;
  /** Which contact in `recon-contacts` receives this. The authority; the hint below is prose. */
  recipient_contact_id: string;
  recipient_hint: string;
  /** Which template produced the subject/body below, and the values substituted into it. */
  template_id: string;
  variables: Record<string, string>;
  /** The RENDERED subject and body. What the analyst approves is what the interceptor compares. */
  subject: string;
  body: string;
  draft_status: DraftStatus;
  /** Non-null only when `draft_status` is `render_failed`; names why the render failed. */
  render_error: string | null;
  revision: number;
  /** The revision that was approved; compared against `revision` at send time. */
  approved_revision: number | null;
  edited_by: string | null;
  edited_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  discarded_by: string | null;
  discarded_at: string | null;
  /** Stamped immediately before the Graph call; with `sent_at` unset it means "outcome unknown". */
  send_attempted_at: string | null;
  sent_at: string | null;
}

/** A conditional write lost: the caller's view of the draft is stale, or the action is illegal. */
export class DraftConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftConflict";
  }
}

function ddb() {
  return new DynamoDBClient({ region: REGION });
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Attribute-name aliases for every field these expressions touch.
 *
 * Aliased indiscriminately rather than only where DynamoDB requires it: the reserved-word list is
 * long and grows, and a write that fails in production because someone used a bare `body` is an
 * avoidable outage.
 */
const NAMES: Record<string, string> = {
  "#pe": "proposed_email",
  "#st": "status",
  "#rev": "revision",
  "#ds": "draft_status",
  "#ar": "approved_revision",
  "#rcid": "recipient_contact_id",
  "#rerr": "render_error",
  "#subj": "subject",
  "#body": "body",
  "#eb": "edited_by",
  "#ea": "edited_at",
  "#ab": "approved_by",
  "#aa": "approved_at",
  "#db": "discarded_by",
  "#da": "discarded_at",
  "#sa": "send_attempted_at",
  "#sent": "sent_at",
};

/**
 * Statuses a draft can still be acted on from. `sent` and `discarded` are terminal.
 *
 * `render_failed` is here so the analyst has a way out of one: editing it writes their own subject and
 * body and returns it to `pending`, and discarding it records that this case will not write to the
 * counterparty. Leaving it out would mean the only exit was an operator fixing the template and the
 * case being re-investigated — with the case blocked in the meantime, since the case decision refuses
 * to close over an undecided draft. Approving one is still impossible: {@link approveDraft} allows
 * only `pending`, so the broken text can never be the text that goes out.
 */
const LIVE_STATUSES: DraftStatus[] = ["pending", "approved", "render_failed"];

/**
 * Narrow the alias/value maps to what the given expressions actually reference.
 *
 * DynamoDB rejects the whole request when `ExpressionAttributeNames` or `ExpressionAttributeValues`
 * carries an entry no expression uses ("unused in expressions"), so passing the full {@link NAMES}
 * map — or a `:null` a conditional branch turned out not to need — is a ValidationException rather
 * than a harmless extra. Deriving the maps from the expression text keeps the two in step no matter
 * which branches a caller assembled.
 *
 * @param placeholders - the union of aliases/values known to this module.
 * @param expressions - every expression string going into the request.
 * @returns only the entries referenced by those expressions.
 * @throws Error when an expression references a placeholder nothing defines — a typo caught here
 *   instead of as an opaque DynamoDB syntax error.
 */
function usedPlaceholders<T>(
  placeholders: Record<string, T>,
  expressions: string[],
  pattern: RegExp,
): Record<string, T> {
  const referenced = new Set(expressions.join(" ").match(pattern) ?? []);
  const out: Record<string, T> = {};
  for (const key of referenced) {
    if (!(key in placeholders))
      throw new Error(`expression references undefined placeholder ${key}`);
    out[key] = placeholders[key];
  }
  return out;
}

/**
 * Explain a failed condition by reading the row back.
 *
 * @param id - the case id.
 * @param revision - the revision the caller believed was current.
 * @param allowed - the draft statuses the attempted action is legal from.
 * @returns a message naming the actual reason, for a 409 the analyst can act on.
 */
async function diagnose(
  id: string,
  revision: number,
  allowed: DraftStatus[],
): Promise<string> {
  const resp = await ddb().send(
    new GetItemCommand({ TableName: CASES_TABLE, Key: { item_id: { S: id } } }),
  );
  if (!resp.Item) return `case ${id} no longer exists`;
  const row = unmarshall(resp.Item);
  const draft = row.proposed_email as PersistedDraft | undefined;
  if (!draft) return "this case has no email draft";
  if (row.status !== "PROPOSED")
    return `the case is ${row.status}, so its draft can no longer be changed`;
  if (Number(draft.revision) !== revision)
    return (
      `the draft changed while you were working on it ` +
      `(it is now revision ${draft.revision}, you sent ${revision}) — reload the case`
    );
  if (!allowed.includes(draft.draft_status))
    return `the draft is ${draft.draft_status}, so this action no longer applies`;
  // Nothing above explains it, which means the row moved again between the failed write and this
  // read. Say that rather than inventing a reason.
  return "the draft changed while you were working on it — reload the case";
}

/**
 * Apply one conditional mutation to `proposed_email` and return the resulting draft.
 *
 * @param id - the case id.
 * @param revision - the revision being acted on; the write fails unless it is still current.
 * @param allowed - draft statuses this action is legal from.
 * @param sets - `SET` clause fragments (aliased names only).
 * @param values - expression values, unmarshalled form.
 * @param extraConditions - additional `ConditionExpression` fragments, ANDed in.
 * @returns the updated draft (`ALL_NEW`).
 * @throws DraftConflict when the condition fails.
 */
async function mutate({
  id,
  revision,
  allowed,
  sets,
  values,
  extraConditions = [],
}: {
  id: string;
  revision: number;
  allowed: DraftStatus[];
  sets: string[];
  values: Record<string, unknown>;
  extraConditions?: string[];
}): Promise<PersistedDraft> {
  const statusValues: Record<string, unknown> = {};
  allowed.forEach((s, i) => {
    statusValues[`:ds${i}`] = s;
  });
  const conditions = [
    "attribute_exists(item_id)",
    "attribute_exists(#pe)",
    // The case itself must still be awaiting a decision; a resolved case's draft is history.
    "#st = :proposed",
    "#pe.#rev = :rev",
    `#pe.#ds IN (${allowed.map((_, i) => `:ds${i}`).join(", ")})`,
    ...extraConditions,
  ];
  const update = `SET ${sets.join(", ")}`;
  const condition = conditions.join(" AND ");
  const allValues = {
    ":rev": revision,
    ":proposed": "PROPOSED",
    ...statusValues,
    ...values,
  };
  try {
    const out = await ddb().send(
      new UpdateItemCommand({
        TableName: CASES_TABLE,
        Key: { item_id: { S: id } },
        UpdateExpression: update,
        ConditionExpression: condition,
        ExpressionAttributeNames: usedPlaceholders(
          NAMES,
          [update, condition],
          /#\w+/g,
        ),
        ExpressionAttributeValues: marshall(
          usedPlaceholders(allValues, [update, condition], /:\w+/g),
          { removeUndefinedValues: true },
        ),
        ReturnValues: "ALL_NEW",
      }),
    );
    return unmarshall(out.Attributes ?? {}).proposed_email as PersistedDraft;
  } catch (err) {
    if ((err as Error).name === "ConditionalCheckFailedException") {
      throw new DraftConflict(await diagnose(id, revision, allowed));
    }
    throw err;
  }
}

/**
 * Record an analyst's edit: new recipient contact, subject and body at the next revision.
 *
 * The edit REVOKES any approval — `draft_status` returns to `pending` and `approved_revision`,
 * `approved_by` and `approved_at` are cleared. Without that, an approval recorded against the old
 * text would silently carry over to text nobody read, which is the exact substitution this
 * feature exists to prevent.
 *
 * A contact ID is written, never an address. `recipient` stays NULL for the life of the row; the
 * address is derived from this id at send time, so pointing the draft at a contact that is later
 * deactivated makes the approved draft unsendable with no further action.
 *
 * `render_error` is cleared as a matter of course: the analyst has just supplied their own subject and
 * body, so a stale explanation of why the agent's template render failed would sit on the case
 * contradicting text that renders fine.
 *
 * @param id - the case id.
 * @param recipientContactId - the contact the analyst picked (already validated by the caller).
 * @param subject - the edited subject.
 * @param body - the edited body.
 * @param revision - the revision the analyst was editing.
 * @param editedBy - the verified caller subject, for the record of who wrote this text.
 * @returns the updated draft, at `revision + 1`.
 * @throws DraftConflict when the draft moved, or is no longer editable.
 */
export async function editDraft({
  id,
  recipientContactId,
  subject,
  body,
  revision,
  editedBy,
}: {
  id: string;
  recipientContactId: string;
  subject: string;
  body: string;
  revision: number;
  editedBy: string;
}): Promise<PersistedDraft> {
  return mutate({
    id,
    revision,
    allowed: LIVE_STATUSES,
    sets: [
      "#pe.#rcid = :rcid",
      "#pe.#rerr = :null",
      "#pe.#subj = :subj",
      "#pe.#body = :body",
      "#pe.#rev = :next",
      "#pe.#ds = :pending",
      "#pe.#ar = :null",
      "#pe.#ab = :null",
      "#pe.#aa = :null",
      "#pe.#eb = :eb",
      "#pe.#ea = :ea",
    ],
    values: {
      ":rcid": recipientContactId,
      ":subj": subject,
      ":body": body,
      ":next": revision + 1,
      ":pending": "pending",
      ":null": null,
      ":eb": editedBy,
      ":ea": nowIso(),
    },
  });
}

/**
 * Approve the draft at `revision`, arming it for a send at that revision and no other.
 *
 * @param id - the case id.
 * @param revision - the revision the analyst read and approved.
 * @param approvedBy - the verified caller subject.
 * @returns the approved draft.
 * @throws DraftConflict when the draft moved, is not `pending`, or names no recipient contact.
 */
export async function approveDraft({
  id,
  revision,
  approvedBy,
}: {
  id: string;
  revision: number;
  approvedBy: string;
}): Promise<PersistedDraft> {
  try {
    return await mutate({
      id,
      revision,
      allowed: ["pending"],
      // A recipient contact is required to approve, not merely to send: approving is the analyst's
      // statement that this message is ready to go out, and one addressed to nobody is not. The
      // check is on the contact id, because `recipient` is NULL on every row by design and a check
      // on it would fail every approve.
      extraConditions: ["attribute_type(#pe.#rcid, :string)"],
      sets: [
        "#pe.#ds = :approved",
        "#pe.#ar = :rev",
        "#pe.#ab = :ab",
        "#pe.#aa = :aa",
      ],
      values: {
        ":approved": "approved",
        ":ab": approvedBy,
        ":aa": nowIso(),
        ":string": "S",
      },
    });
  } catch (err) {
    // `diagnose` cannot see the recipient condition (it is specific to this action), so name it
    // here rather than letting a missing contact report as a generic "the draft changed".
    if (
      err instanceof DraftConflict &&
      err.message.startsWith("the draft changed")
    ) {
      throw new DraftConflict(
        `${err.message} (if the draft names no recipient yet, pick one before approving)`,
      );
    }
    throw err;
  }
}

/**
 * Withdraw an approval, returning the draft to `pending` without changing its text.
 *
 * @param id - the case id.
 * @param revision - the revision whose approval is being withdrawn.
 * @param actor - the verified caller subject.
 * @returns the draft, back at `pending`.
 * @throws DraftConflict when the draft moved or is not `approved`.
 */
export async function revokeDraftApproval({
  id,
  revision,
  actor,
}: {
  id: string;
  revision: number;
  actor: string;
}): Promise<PersistedDraft> {
  return mutate({
    id,
    revision,
    allowed: ["approved"],
    sets: [
      "#pe.#ds = :pending",
      "#pe.#ar = :null",
      "#pe.#ab = :null",
      "#pe.#aa = :null",
      "#pe.#eb = :eb",
      "#pe.#ea = :ea",
    ],
    values: {
      ":pending": "pending",
      ":null": null,
      ":eb": actor,
      ":ea": nowIso(),
    },
  });
}

/**
 * Discard the draft: this case will not send a counterparty email.
 *
 * Terminal, and deliberately not a delete — the record that a draft existed and was rejected is
 * part of the case's history, and the panel renders it read-only.
 *
 * @param id - the case id.
 * @param revision - the revision being discarded.
 * @param discardedBy - the verified caller subject.
 * @returns the discarded draft.
 * @throws DraftConflict when the draft moved or was already sent/discarded.
 */
export async function discardDraft({
  id,
  revision,
  discardedBy,
}: {
  id: string;
  revision: number;
  discardedBy: string;
}): Promise<PersistedDraft> {
  return mutate({
    id,
    revision,
    allowed: LIVE_STATUSES,
    sets: ["#pe.#ds = :discarded", "#pe.#db = :db", "#pe.#da = :da"],
    values: { ":discarded": "discarded", ":db": discardedBy, ":da": nowIso() },
  });
}

/**
 * Claim the send: stamp `send_attempted_at` before the Graph call, and only from the approved
 * revision.
 *
 * This is the at-most-once half of the idempotency story. The stamp is written FIRST so that a
 * process that dies mid-send leaves evidence: `send_attempted_at` set with `sent_at` unset means
 * "we do not know whether the counterparty received this", which the UI surfaces as a distinct
 * warning instead of quietly offering a retry that could double-send.
 *
 * @param id - the case id.
 * @param revision - the revision being sent; must equal both `revision` and `approved_revision`.
 * @param allowRetry - when true, permit a re-arm despite an existing `send_attempted_at`. Only
 *   set this from an explicit human override, after the shared mailbox's Sent Items was checked.
 * @returns the armed draft — the caller sends exactly the text this returns, never the request's.
 * @throws DraftConflict when the draft is not approved at this revision, or a send was already
 *   attempted and `allowRetry` is false.
 */
export async function armSend({
  id,
  revision,
  allowRetry = false,
}: {
  id: string;
  revision: number;
  allowRetry?: boolean;
}): Promise<PersistedDraft> {
  const extraConditions = [
    // The interceptor enforces this too; enforcing it here as well means an unpinned approval
    // never even reaches the gateway.
    "#pe.#ar = :rev",
  ];
  if (!allowRetry) {
    // `build_persisted_draft` initializes these to null, so "unset" is NULL rather than absent —
    // an attribute_not_exists-only check would let a re-send through on the retry path.
    extraConditions.push(
      "(attribute_not_exists(#pe.#sa) OR #pe.#sa = :null)",
      "(attribute_not_exists(#pe.#sent) OR #pe.#sent = :null)",
    );
  }
  try {
    return await mutate({
      id,
      revision,
      allowed: ["approved"],
      extraConditions,
      sets: ["#pe.#sa = :sa"],
      values: { ":sa": nowIso(), ":null": null },
    });
  } catch (err) {
    if (
      err instanceof DraftConflict &&
      err.message.startsWith("the draft changed")
    ) {
      throw new DraftConflict(
        "a send was already attempted for this draft and its outcome is unknown — " +
          "check the shared mailbox's Sent Items, then retry with the override if nothing was sent",
      );
    }
    throw err;
  }
}

/**
 * Record a completed send: `sent_at` stamped and the draft moved to `sent` (terminal).
 *
 * Unconditional on purpose. The mail has left the building; refusing to record that because the
 * row moved would be strictly worse than recording it — a `sent` draft the interceptor will no
 * longer authorize is the safe end state.
 *
 * @param id - the case id.
 * @returns None.
 */
export async function markSent(id: string): Promise<void> {
  const update = "SET #pe.#ds = :sent_status, #pe.#sent = :sent";
  const condition = "attribute_exists(#pe)";
  await ddb().send(
    new UpdateItemCommand({
      TableName: CASES_TABLE,
      Key: { item_id: { S: id } },
      UpdateExpression: update,
      ConditionExpression: condition,
      ExpressionAttributeNames: usedPlaceholders(
        NAMES,
        [update, condition],
        /#\w+/g,
      ),
      ExpressionAttributeValues: marshall({
        ":sent_status": "sent",
        ":sent": nowIso(),
      }),
    }),
  );
}

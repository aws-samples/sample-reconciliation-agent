// @vitest-environment node
/**
 * Tests for the conditional draft writes (`src/lib/emailDraftStore.ts`).
 *
 * Two things are worth testing here and they are different in kind. The first is policy: an edit
 * revokes the approval, an arm pins the approved revision, a re-send needs an override. The second
 * is mechanical, and it is the one that bites in production — DynamoDB rejects the entire request
 * when `ExpressionAttributeNames`/`Values` carries an entry no expression references, so a
 * placeholder map that is merely *generous* is an outage rather than waste. `expectExactPlaceholders`
 * below asserts the maps and the expressions agree in both directions on every single write, which
 * is the only cheap way to catch that: tsc cannot see it, and a live call fails only at the moment
 * an analyst is trying to send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CASES_TABLE = "recon-dev-cases";

const send = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send })),
  UpdateItemCommand: vi.fn().mockImplementation((i) => ({
    __cmd: "Update",
    input: i,
  })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({
    __cmd: "Get",
    input: i,
  })),
}));

const { marshall } = await import("@aws-sdk/util-dynamodb");
const store = await import("@/lib/emailDraftStore");

/** A draft row as `build_persisted_draft` writes it, overridable per test. */
function draftRow(over: Record<string, unknown> = {}) {
  return {
    // Null in every row this system writes; the address lives in the contacts table and is resolved
    // at send time. Present here because the attribute IS written, as NULL.
    recipient: null,
    recipient_contact_id: "c-ap-1",
    recipient_hint: "Counterparty AP",
    template_id: "tpl-short-pay",
    variables: { invoice: "42" },
    subject: "Invoice 42",
    body: "Please confirm.",
    draft_status: "approved",
    render_error: null,
    revision: 3,
    approved_revision: 3,
    edited_by: null,
    edited_at: null,
    approved_by: "analyst@x.com",
    approved_at: "2026-08-09T00:00:00.000Z",
    discarded_by: null,
    discarded_at: null,
    send_attempted_at: null,
    sent_at: null,
    ...over,
  };
}

/** The `UpdateItem` input from the Nth call (0-based). */
function updateInput(n = 0) {
  return send.mock.calls[n][0].input;
}

/**
 * Assert the placeholder maps are exactly what the expressions reference — no missing entry (a
 * syntax error) and no extra entry (a ValidationException that kills the whole request).
 */
function expectExactPlaceholders(input: {
  UpdateExpression: string;
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}) {
  const text = `${input.UpdateExpression} ${input.ConditionExpression}`;
  const names = new Set(text.match(/#\w+/g) ?? []);
  const values = new Set(text.match(/:\w+/g) ?? []);
  expect(new Set(Object.keys(input.ExpressionAttributeNames ?? {}))).toEqual(
    names,
  );
  expect(new Set(Object.keys(input.ExpressionAttributeValues ?? {}))).toEqual(
    values,
  );
}

/** Make the next `send` succeed, returning `row` as the post-write draft. */
function resolveWith(row: Record<string, unknown>) {
  send.mockResolvedValueOnce({ Attributes: marshall({ proposed_email: row }) });
}

/** Make the next `send` fail the condition, the way DynamoDB reports it. */
function failCondition() {
  const err = new Error("The conditional request failed");
  err.name = "ConditionalCheckFailedException";
  send.mockRejectedValueOnce(err);
}

/** Answer the diagnosing re-read with `row` (or nothing, for a deleted case). */
function diagnoseWith(row: Record<string, unknown> | null) {
  send.mockResolvedValueOnce(
    row
      ? { Item: marshall({ item_id: "i-1", status: "PROPOSED", ...row }) }
      : {},
  );
}

describe("emailDraftStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("edits at the next revision, back to pending, with the approval cleared", async () => {
    resolveWith(draftRow({ revision: 4, draft_status: "pending" }));
    await store.editDraft({
      id: "i-1",
      recipientContactId: "c-ap-1",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
      editedBy: "analyst@x.com",
    });

    const input = updateInput();
    expectExactPlaceholders(input);
    // A contact id goes in, never an address — that is what makes deactivating a contact tomorrow
    // revoke this draft without anyone editing the case.
    expect(input.UpdateExpression).toContain("#pe.#rcid = :rcid");
    expect(input.ExpressionAttributeValues[":rcid"]).toEqual({ S: "c-ap-1" });
    expect(input.ExpressionAttributeNames).not.toHaveProperty("#rcpt");
    // A stale render_error would otherwise sit on the case explaining why text that renders fine
    // could not be rendered.
    expect(input.UpdateExpression).toContain("#pe.#rerr = :null");
    // The approval does not survive an edit: were `approved_revision` left at 3 while `revision`
    // moved to 4, the interceptor's equality check is the only thing standing between an analyst's
    // approval and text nobody read.
    expect(input.UpdateExpression).toContain("#pe.#ds = :pending");
    expect(input.UpdateExpression).toContain("#pe.#ar = :null");
    expect(input.ExpressionAttributeValues[":next"]).toEqual({ N: "4" });
    expect(input.ExpressionAttributeValues[":pending"]).toEqual({
      S: "pending",
    });
    expect(input.ExpressionAttributeValues[":null"]).toEqual({ NULL: true });
    // Pinned to the revision the analyst was editing, and only from a live draft.
    expect(input.ConditionExpression).toContain("#pe.#rev = :rev");
    expect(input.ConditionExpression).toContain("#st = :proposed");
    // pending, approved, render_failed — the three states an analyst can still act on. The last is
    // editable so a draft whose template would not render has an exit that is not "abandon the case".
    expect(input.ConditionExpression).toContain(
      "#pe.#ds IN (:ds0, :ds1, :ds2)",
    );
    expect(input.ExpressionAttributeValues[":ds2"]).toEqual({
      S: "render_failed",
    });
  });

  it("approves only a pending draft that already names a recipient contact", async () => {
    resolveWith(draftRow());
    await store.approveDraft({
      id: "i-1",
      revision: 3,
      approvedBy: "analyst@x.com",
    });

    const input = updateInput();
    expectExactPlaceholders(input);
    expect(input.ConditionExpression).toContain("#pe.#ds IN (:ds0)");
    expect(input.ExpressionAttributeValues[":ds0"]).toEqual({ S: "pending" });
    // On the contact id, not on `recipient`. `recipient` is NULL on every row, so the old check on
    // it would now fail every approve — and `attribute_type(x, "S")` is false for NULL, which is the
    // sort of failure that surfaces as "the draft changed" and sends nobody anywhere useful.
    expect(input.ConditionExpression).toContain(
      "attribute_type(#pe.#rcid, :string)",
    );
    // The approval names the revision it approves — this is what the interceptor compares.
    expect(input.UpdateExpression).toContain("#pe.#ar = :rev");
  });

  it("arms a send pinned to the approved revision and to a never-attempted draft", async () => {
    resolveWith(draftRow({ send_attempted_at: "2026-08-09T10:00:00.000Z" }));
    await store.armSend({ id: "i-1", revision: 3 });

    const input = updateInput();
    expectExactPlaceholders(input);
    expect(input.ConditionExpression).toContain("#pe.#ar = :rev");
    // `build_persisted_draft` writes explicit NULLs, so "never attempted" is NULL and not absent;
    // an attribute_not_exists-only guard would wave a second send straight through.
    expect(input.ConditionExpression).toContain(
      "(attribute_not_exists(#pe.#sa) OR #pe.#sa = :null)",
    );
    expect(input.ConditionExpression).toContain(
      "(attribute_not_exists(#pe.#sent) OR #pe.#sent = :null)",
    );
  });

  it("drops the never-attempted guard only when a human overrides", async () => {
    resolveWith(draftRow());
    await store.armSend({ id: "i-1", revision: 3, allowRetry: true });

    const input = updateInput();
    expectExactPlaceholders(input);
    expect(input.ConditionExpression).not.toContain(
      "attribute_not_exists(#pe.#sa)",
    );
    // Still pinned to the approved revision: an override forgives an unknown outcome, not a
    // mismatch between what was approved and what is about to go out.
    expect(input.ConditionExpression).toContain("#pe.#ar = :rev");
  });

  it("refuses a re-send and says to check Sent Items first", async () => {
    failCondition();
    diagnoseWith({
      proposed_email: draftRow({
        send_attempted_at: "2026-08-09T10:00:00.000Z",
      }),
    });

    await expect(store.armSend({ id: "i-1", revision: 3 })).rejects.toThrow(
      /already attempted .* outcome is unknown/,
    );
  });

  it("reports a lost revision race with both numbers", async () => {
    failCondition();
    diagnoseWith({ proposed_email: draftRow({ revision: 5 }) });

    await expect(
      store.editDraft({
        id: "i-1",
        recipientContactId: "c-ap-1",
        subject: "s",
        body: "b",
        revision: 3,
        editedBy: "analyst@x.com",
      }),
    ).rejects.toThrow(/now revision 5, you sent 3/);
  });

  it("reports a draft already discarded rather than a generic conflict", async () => {
    failCondition();
    diagnoseWith({ proposed_email: draftRow({ draft_status: "discarded" }) });

    await expect(
      store.approveDraft({ id: "i-1", revision: 3, approvedBy: "a@x.com" }),
    ).rejects.toThrow(/the draft is discarded/);
  });

  it("mentions a missing recipient contact when nothing else explains a failed approve", async () => {
    failCondition();
    // Everything `diagnose` can see is fine, so the contact-id condition is what failed.
    diagnoseWith({ proposed_email: draftRow({ draft_status: "pending" }) });

    await expect(
      store.approveDraft({ id: "i-1", revision: 3, approvedBy: "a@x.com" }),
    ).rejects.toThrow(/names no recipient yet/);
  });

  it("lets a failed render be discarded, so a broken template cannot strand a case", async () => {
    resolveWith(draftRow({ draft_status: "discarded" }));
    await store.discardDraft({
      id: "i-1",
      revision: 3,
      discardedBy: "analyst@x.com",
    });

    const input = updateInput();
    expectExactPlaceholders(input);
    expect(input.ExpressionAttributeValues[":ds2"]).toEqual({
      S: "render_failed",
    });
  });

  it("surfaces a non-condition failure as itself", async () => {
    send.mockRejectedValueOnce(new Error("ProvisionedThroughputExceeded"));
    await expect(
      store.discardDraft({ id: "i-1", revision: 3, discardedBy: "a@x.com" }),
    ).rejects.toThrow("ProvisionedThroughputExceeded");
    // Not a conflict — retrying with a reloaded revision would not help.
    await expect(
      store.discardDraft({ id: "i-1", revision: 3, discardedBy: "a@x.com" }),
    ).rejects.not.toBeInstanceOf(store.DraftConflict);
  });

  it("records a completed send without pinning the revision", async () => {
    send.mockResolvedValueOnce({});
    await store.markSent("i-1");

    const input = updateInput();
    expectExactPlaceholders(input);
    // The mail is gone. Refusing to write that down because the row moved would leave a draft the
    // UI still offers to send.
    expect(input.ConditionExpression).toBe("attribute_exists(#pe)");
    expect(input.UpdateExpression).toContain("#pe.#ds = :sent_status");
  });
});

// @vitest-environment node
/**
 * Tests for the counterparty-email draft routes: `PUT /api/recon/cases/[id]/draft` (edit) and the
 * draft-lifecycle + send actions on `POST /api/recon/cases/[id]`.
 *
 * The node environment is deliberate: these routes call `authorizeRequest`, which pulls in `jose`,
 * and jsdom's cross-realm `Uint8Array` makes it throw before any assertion runs (recorded in the
 * P0-2 notes).
 *
 * What is actually being pinned down here is that no request body can reach a counterparty's
 * inbox. The gateway interceptor is the boundary that guarantees it, so these tests check the
 * things the interceptor cannot: that the send carries the fields the interceptor needs to judge
 * it, that the message is copied from the armed row rather than the request, and that every
 * failure leaves the case PROPOSED so a retry is a retry rather than a second send.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CASES_TABLE = "recon-dev-cases";
process.env.COUNTERPARTY_EMAIL_DOMAINS = "counterparty.example";
process.env.GRAPH_MAILBOX = "shared@operator.example";
process.env.NOTIFY_CONTACT_ID = "notify-primary";
process.env.RECON_GATEWAY_URL = "https://gw.example/mcp";
process.env.EMAIL_CONFIRMATION_TOKEN = "tok-123";

const ddbSend = vi.fn();
const callGatewayTool = vi.fn();
const authorizeRequest = vi.fn();
const resolveContactAddress = vi.fn();
const editDraft = vi.fn();
const approveDraft = vi.fn();
const revokeDraftApproval = vi.fn();
const discardDraft = vi.fn();
const armSend = vi.fn();
const markSent = vi.fn();

vi.mock("@aws-sdk/client-dynamodb", () => ({
  DynamoDBClient: vi.fn().mockImplementation(() => ({ send: ddbSend })),
  GetItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Get", ...i })),
  UpdateItemCommand: vi
    .fn()
    .mockImplementation((i) => ({ __cmd: "Update", ...i })),
  PutItemCommand: vi.fn().mockImplementation((i) => ({ __cmd: "Put", ...i })),
}));
vi.mock("@/lib/gatewayMcp", () => ({ callGatewayTool }));
vi.mock("@/lib/api-auth", () => ({ authorizeRequest }));
vi.mock("@/lib/reconMemory", () => ({ recordLessonMemoryEvent: vi.fn() }));
vi.mock("@/lib/rescoreAgreement", () => ({ rescoreAgreement: vi.fn() }));
vi.mock("@/lib/contactStore", () => ({
  // Real class again: the draft route branches on `instanceof` to tell an unsendable contact (400,
  // the analyst picked badly) from a DynamoDB failure (502, nobody picked badly).
  ContactUnavailable: class ContactUnavailable extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ContactUnavailable";
    }
  },
  resolveContactAddress,
}));
vi.mock("@/lib/emailDraftStore", () => ({
  // A real class, because both routes branch on `instanceof DraftConflict` to choose 409 over 502.
  DraftConflict: class DraftConflict extends Error {
    constructor(message: string) {
      super(message);
      this.name = "DraftConflict";
    }
  },
  editDraft,
  approveDraft,
  revokeDraftApproval,
  discardDraft,
  armSend,
  markSent,
}));

const { marshall } = await import("@aws-sdk/util-dynamodb");
const { DraftConflict } = await import("@/lib/emailDraftStore");
const { ContactUnavailable } = await import("@/lib/contactStore");
const { PUT } = await import("@/app/api/recon/cases/[id]/draft/route");
const { POST } = await import("@/app/api/recon/cases/[id]/route");

const params = { params: Promise.resolve({ id: "i-1" }) };

function request(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const putDraft = (body: unknown) =>
  PUT(request("http://x/api/recon/cases/i-1/draft", "PUT", body), params);

const postCase = (body: unknown) =>
  POST(request("http://x/api/recon/cases/i-1", "POST", body), params);

/**
 * A persisted draft, `approved` at revision 3 unless overridden.
 *
 * `recipient` is null and stays null — no row in this system stores an address. The id below is what
 * both the send path and the interceptor resolve, separately, to find out where the mail goes.
 */
function draft(over: Record<string, unknown> = {}) {
  return {
    recipient: null,
    recipient_contact_id: "c-ap-1",
    recipient_hint: "Counterparty AP",
    template_id: "tpl-short-pay",
    variables: { invoice: "42" },
    subject: "Invoice 42 — short payment",
    body: "We received 900.00 against invoice 42 for 1000.00.",
    draft_status: "approved",
    render_error: null,
    revision: 3,
    approved_revision: 3,
    send_attempted_at: null,
    sent_at: null,
    ...over,
  };
}

/** The address `c-ap-1` resolves to by default. In the allowlist, so the happy path stays happy. */
const AP_ADDRESS = "ap@counterparty.example";

/** Seed the case row `getCase` reads. */
function seedCase(over: Record<string, unknown> = {}) {
  ddbSend.mockResolvedValue({
    Item: marshall(
      {
        item_id: "i-1",
        status: "PROPOSED",
        domain: "loan_ops",
        class_id: "SHORT_PAY",
        resolution: "Contact counterparty",
        ...over,
      },
      { removeUndefinedValues: true },
    ),
  });
}

/** Every `callGatewayTool` invocation, as [toolName, args] pairs in call order. */
function gatewayCalls(): Array<[string, Record<string, unknown>]> {
  return callGatewayTool.mock.calls as Array<[string, Record<string, unknown>]>;
}

/** The arguments of the one counterparty send, failing if there wasn't exactly one. */
function counterpartySend(): Record<string, unknown> {
  const sends = gatewayCalls().filter(
    ([, args]) => args.sendPurpose === "counterparty",
  );
  expect(sends).toHaveLength(1);
  return sends[0][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeRequest.mockResolvedValue({ ok: true, subject: "analyst@x.com" });
  resolveContactAddress.mockResolvedValue(AP_ADDRESS);
  callGatewayTool.mockResolvedValue({
    structuredContent: { transitioned: true },
  });
});

describe("PUT /api/recon/cases/[id]/draft", () => {
  it("stores the contact id, not an address, under the verified caller's identity", async () => {
    editDraft.mockResolvedValue(
      draft({ revision: 4, draft_status: "pending" }),
    );
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).proposed_email.draft_status).toBe("pending");
    // `edited_by` is who wrote text that may leave the operator, so it comes from the token and
    // never from the body — a client claiming to be someone else changes nothing here.
    expect(editDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "i-1",
        recipientContactId: "c-ap-1",
        editedBy: "analyst@x.com",
      }),
    );
    // The address was resolved to check it, then dropped. Persisting it would mean deactivating the
    // contact tomorrow left this row still pointing at a live address.
    expect(editDraft.mock.calls[0][0]).not.toHaveProperty("recipient");
  });

  it("refuses a body that supplies an address instead of a contact", async () => {
    const res = await putDraft({
      recipient: "ap@attacker.example",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
    });

    // Not "the address is out of policy" but "this field does not exist here". A client cannot
    // choose the address at all, so there is nothing for an attacker-supplied one to influence.
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /recipient_contact_id is required/,
    );
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("saves a draft to a contact outside the send gate, and leaves the gate to the gateway", async () => {
    // This route does NOT domain-check. `counterparty_email_domains` is a gate and the gateway request
    // interceptor is the gate: it re-derives the verdict from its own copy on every send, against the
    // stored text at the approved revision. A second opinion here read a container env var fixed at
    // task start, so it could only ever agree with the interceptor or be WRONG -- and being wrong meant
    // refusing a draft the deployment would in fact have sent.
    //
    // The draft is still only editable, not sendable: nothing about saving it authorizes a send.
    resolveContactAddress.mockResolvedValue("ap@attacker.example");
    const res = await putDraft({
      recipient_contact_id: "c-old-1",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
    });

    expect(res.status).toBe(200);
    expect(editDraft).toHaveBeenCalledTimes(1);
  });

  it("still resolves the contact, so an unresolvable one fails here and not at send time", async () => {
    // The address is resolved even though it is not domain-checked: that is what makes a deactivated or
    // deleted contact fail now, while an analyst is looking at it, instead of after they approve.
    resolveContactAddress.mockResolvedValue("ap@notcounterparty.example");
    const res = await putDraft({
      recipient_contact_id: "c-look-1",
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(200);
    expect(resolveContactAddress).toHaveBeenCalled();
  });

  it("rejects a deactivated contact at edit time rather than at send time", async () => {
    // The whole reason the row stores an id: this refusal is available the moment the analyst picks,
    // and again independently in the interceptor when the send is attempted. Getting it here means
    // nobody approves a draft that was never sendable.
    resolveContactAddress.mockRejectedValue(
      new ContactUnavailable(
        "contact c-gone-1 is deactivated and cannot be sent to",
      ),
    );
    const res = await putDraft({
      recipient_contact_id: "c-gone-1",
      subject: "s",
      body: "b",
      revision: 3,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/deactivated/);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("reports a contacts-table failure as 502, not as a bad choice by the analyst", async () => {
    resolveContactAddress.mockRejectedValue(
      new Error("DynamoDB: ProvisionedThroughputExceeded"),
    );
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "s",
      body: "b",
      revision: 3,
    });

    expect(res.status).toBe(502);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("requires a recipient_contact_id", async () => {
    const res = await putDraft({
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(
      /recipient_contact_id is required/,
    );
    expect(resolveContactAddress).not.toHaveBeenCalled();
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("requires the revision rather than defaulting it", async () => {
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "s",
      body: "b",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/revision is required/);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("requires a subject and a body", async () => {
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "  ",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(400);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("passes a lost race through as 409 with the store's explanation", async () => {
    editDraft.mockRejectedValue(
      new DraftConflict("the draft changed while you were working on it"),
    );
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed while you were working/);
  });

  it("refuses an unauthenticated caller", async () => {
    authorizeRequest.mockResolvedValue({
      ok: false,
      status: 401,
      message: "missing bearer token",
    });
    const res = await putDraft({
      recipient_contact_id: "c-ap-1",
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(401);
    // Not even a read of the contacts table on an unauthenticated request.
    expect(resolveContactAddress).not.toHaveBeenCalled();
    expect(editDraft).not.toHaveBeenCalled();
  });
});

describe("POST /api/recon/cases/[id] — draft lifecycle", () => {
  it("approves the draft at the pinned revision, without touching the case", async () => {
    seedCase({ proposed_email: draft({ draft_status: "pending" }) });
    approveDraft.mockResolvedValue(draft());
    const res = await postCase({ action: "approve_draft", draft_revision: 3 });

    expect(res.status).toBe(200);
    expect((await res.json()).proposed_email.draft_status).toBe("approved");
    expect(approveDraft).toHaveBeenCalledWith({
      id: "i-1",
      revision: 3,
      approvedBy: "analyst@x.com",
    });
    // A draft decision is not a case decision — nothing was transitioned.
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("routes revoke and discard to their own writes", async () => {
    seedCase({ proposed_email: draft() });
    revokeDraftApproval.mockResolvedValue(draft({ draft_status: "pending" }));
    discardDraft.mockResolvedValue(draft({ draft_status: "discarded" }));

    expect(
      (await postCase({ action: "revoke_draft", draft_revision: 3 })).status,
    ).toBe(200);
    expect(revokeDraftApproval).toHaveBeenCalledWith({
      id: "i-1",
      revision: 3,
      actor: "analyst@x.com",
    });
    expect(
      (await postCase({ action: "discard_draft", draft_revision: 3 })).status,
    ).toBe(200);
    expect(discardDraft).toHaveBeenCalledWith({
      id: "i-1",
      revision: 3,
      discardedBy: "analyst@x.com",
    });
  });

  it("requires draft_revision on a draft action", async () => {
    seedCase({ proposed_email: draft({ draft_status: "pending" }) });
    const res = await postCase({ action: "approve_draft" });
    expect(res.status).toBe(400);
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it("404s a draft action on a case with no draft", async () => {
    seedCase();
    const res = await postCase({ action: "approve_draft", draft_revision: 0 });
    expect(res.status).toBe(404);
    expect(approveDraft).not.toHaveBeenCalled();
  });
});

describe("POST /api/recon/cases/[id] — approve with a counterparty draft", () => {
  it("sends the armed row's text with the fields the interceptor needs", async () => {
    seedCase({
      proposed_email: draft(),
      proposed_action: {
        tool: "set_draw_status",
        reference: "DDTL-A-0001",
        status: "Cancelled",
      },
    });
    const armed = draft({ send_attempted_at: "2026-08-09T10:00:00.000Z" });
    armSend.mockResolvedValue(armed);

    const res = await postCase({
      action: "approve",
      comment: "confirmed with the desk",
      draft_revision: 3,
      // A body that tries to redirect the mail. It is ignored twice over: the text comes from
      // `armed`, and the address comes from resolving that row's contact id.
      recipient: "attacker@evil.example",
      recipient_contact_id: "c-attacker-1",
      subject: "Wire instructions changed",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "RESOLVED" });

    const args = counterpartySend();
    expect(args.reconItemId).toBe("i-1");
    expect(args.confirmationToken).toBe("tok-123");
    const message = args.message as Record<string, unknown>;
    expect(message.subject).toBe(armed.subject);
    expect((message.body as { content: string }).content).toBe(armed.body);
    // The address is the armed row's CONTACT resolved server-side, never the body's field and never
    // a stored address — `armed.recipient` is null.
    expect(resolveContactAddress).toHaveBeenCalledWith({
      contactId: "c-ap-1",
      kind: "counterparty",
    });
    expect(message.toRecipients).toEqual([
      { emailAddress: { address: AP_ADDRESS } },
    ]);

    expect(armSend).toHaveBeenCalledWith({
      id: "i-1",
      revision: 3,
      allowRetry: false,
    });
    expect(markSent).toHaveBeenCalledWith("i-1");
    // Ordering: the ledger write, then the counterparty mail, then both status changes, and the
    // operator's own notification last. The irreversible outward act goes last among the things
    // that can fail *before* a status change, so a failure there leaves the case PROPOSED rather
    // than resolved-but-unsent. The notification sits after RESOLVED for the opposite reason: it
    // is internal courtesy mail, and it used to sit between APPROVED and RESOLVED where a Graph
    // outage stranded the case at APPROVED with no transition left to make.
    const order = gatewayCalls().map(([tool, a]) => a.sendPurpose ?? tool);
    expect(order).toEqual([
      "set-draw-status___set_draw_status",
      "counterparty",
      "recon-status___recon_update_status",
      "recon-status___recon_update_status",
      "notification",
    ]);
  });

  it("blocks the case decision while the draft is still pending", async () => {
    seedCase({ proposed_email: draft({ draft_status: "pending" }) });
    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/approve or discard the draft/);
    // RESOLVED is terminal, so resolving now would strand the draft unsendable forever.
    expect(armSend).not.toHaveBeenCalled();
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("blocks the case decision while the draft is stuck on a failed render", async () => {
    // The agent meant to write to the counterparty and the template it cited would not render. If
    // RESOLVED could be reached from here the case would close with the mail neither sent nor
    // consciously abandoned, which is the one outcome nobody can spot afterwards.
    seedCase({
      proposed_email: draft({
        draft_status: "render_failed",
        render_error: "ValueError: template declares no placeholder 'amount'",
        subject: "",
        body: "",
      }),
    });
    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/approve or discard the draft/);
    expect(armSend).not.toHaveBeenCalled();
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("refuses to resolve the case when the approved draft's contact was deactivated", async () => {
    // Deactivating a contact revokes every approved draft aimed at it, with nobody editing a case.
    // The refusal lands before the ledger write and before `armSend`, so no `send_attempted_at`
    // stamp is burned on a send that provably never happened — the analyst repoints the draft at a
    // live contact instead of clearing an "outcome unknown" warning that would be a lie.
    seedCase({ proposed_email: draft() });
    resolveContactAddress.mockRejectedValue(
      new ContactUnavailable(
        "contact c-ap-1 is deactivated and cannot be sent to",
      ),
    );

    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      status: "PROPOSED",
      error: expect.stringContaining("deactivated"),
    });
    expect(armSend).not.toHaveBeenCalled();
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("refuses a stale approval before applying anything", async () => {
    seedCase({ proposed_email: draft({ revision: 5, approved_revision: 5 }) });
    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/now revision 5, you sent 3/);
    // Checked ahead of the ledger write, so a 409 never leaves a half-applied approval behind.
    expect(gatewayCalls()).toHaveLength(0);
    expect(armSend).not.toHaveBeenCalled();
  });

  it("requires draft_revision when a send is implied", async () => {
    seedCase({ proposed_email: draft() });
    const res = await postCase({ action: "approve" });
    expect(res.status).toBe(400);
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("leaves the case PROPOSED with the draft intact when Graph fails", async () => {
    seedCase({ proposed_email: draft() });
    armSend.mockResolvedValue(draft());
    callGatewayTool.mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        if (args.sendPurpose === "counterparty")
          throw new Error("Graph 5xx: mailbox unavailable");
        return { structuredContent: { transitioned: true } };
      },
    );

    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(502);
    // Criterion 7: the case is PROPOSED, the failure is named rather than swallowed behind a
    // generic 502, and the draft is still there to retry.
    expect(await res.json()).toMatchObject({
      status: "PROPOSED",
      error: expect.stringContaining("mailbox unavailable"),
    });
    // Not recorded as sent, and no transition — the retry is a retry, and `send_attempted_at` is
    // already stamped so the next attempt has to be an explicit override.
    expect(markSent).not.toHaveBeenCalled();
    expect(
      gatewayCalls().some(
        ([tool]) => tool === "recon-status___recon_update_status",
      ),
    ).toBe(false);
    // "Intact" means the text and its approval survive: the arm-write's `send_attempted_at` stamp
    // is the only mutation, so nothing here revoked, discarded or re-approved the draft behind the
    // analyst's back. Without this the case could come back PROPOSED with an unsendable draft,
    // which reads the same in the UI but cannot be retried.
    expect(armSend).toHaveBeenCalledTimes(1);
    expect(editDraft).not.toHaveBeenCalled();
    expect(revokeDraftApproval).not.toHaveBeenCalled();
    expect(discardDraft).not.toHaveBeenCalled();
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it("refuses a re-send whose earlier outcome is unknown", async () => {
    seedCase({ proposed_email: draft() });
    armSend.mockRejectedValue(
      new DraftConflict(
        "a send was already attempted for this draft and its outcome is unknown",
      ),
    );

    const res = await postCase({ action: "approve", draft_revision: 3 });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/outcome is unknown/);
    expect(
      gatewayCalls().filter(([, a]) => a.sendPurpose === "counterparty"),
    ).toHaveLength(0);
  });

  it("passes an explicit human override through to the arm-write", async () => {
    seedCase({ proposed_email: draft() });
    armSend.mockResolvedValue(draft());
    await postCase({
      action: "approve",
      draft_revision: 3,
      override_unknown_send: true,
    });
    expect(armSend).toHaveBeenCalledWith({
      id: "i-1",
      revision: 3,
      allowRetry: true,
    });
  });

  it("does not re-send a draft already marked sent", async () => {
    seedCase({
      proposed_email: draft({
        draft_status: "sent",
        sent_at: "2026-08-09T10:00:00.000Z",
      }),
    });
    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(200);
    expect(armSend).not.toHaveBeenCalled();
    expect(
      gatewayCalls().filter(([, a]) => a.sendPurpose === "counterparty"),
    ).toHaveLength(0);
  });

  it("resolves a case whose draft was discarded, sending nothing", async () => {
    seedCase({ proposed_email: draft({ draft_status: "discarded" }) });
    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(200);
    expect(armSend).not.toHaveBeenCalled();
    expect(
      gatewayCalls().filter(([, a]) => a.sendPurpose === "counterparty"),
    ).toHaveLength(0);
    // The operator's own notification still goes out — that path is unrelated to the draft.
    expect(
      gatewayCalls().filter(([, a]) => a.sendPurpose === "notification"),
    ).toHaveLength(1);
  });
});

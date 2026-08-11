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
process.env.RECON_NOTIFY_EMAIL = "ops@operator.example";
process.env.RECON_GATEWAY_URL = "https://gw.example/mcp";
process.env.EMAIL_CONFIRMATION_TOKEN = "tok-123";

const ddbSend = vi.fn();
const callGatewayTool = vi.fn();
const authorizeRequest = vi.fn();
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

/** A persisted draft, `approved` at revision 3 unless overridden. */
function draft(over: Record<string, unknown> = {}) {
  return {
    recipient: "ap@counterparty.example",
    recipient_hint: "Counterparty AP",
    subject: "Invoice 42 — short payment",
    body: "We received 900.00 against invoice 42 for 1000.00.",
    draft_status: "approved",
    revision: 3,
    approved_revision: 3,
    send_attempted_at: null,
    sent_at: null,
    ...over,
  };
}

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
  callGatewayTool.mockResolvedValue({
    structuredContent: { transitioned: true },
  });
});

describe("PUT /api/recon/cases/[id]/draft", () => {
  it("stores an edit under the verified caller's identity", async () => {
    editDraft.mockResolvedValue(
      draft({ revision: 4, draft_status: "pending" }),
    );
    const res = await putDraft({
      recipient: "ap@counterparty.example",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).proposed_email.draft_status).toBe("pending");
    // `edited_by` is who wrote text that may leave the operator, so it comes from the token and
    // never from the body — a client claiming to be someone else changes nothing here.
    expect(editDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "i-1", editedBy: "analyst@x.com" }),
    );
  });

  it("rejects a recipient outside the allowlist and writes nothing", async () => {
    const res = await putDraft({
      recipient: "ap@attacker.example",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 3,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not an allowed/i);
    // The analyst-edit path is where an address supplied by a human enters the system; the whole
    // point of checking here is that nothing out-of-policy gets persisted to be approved later.
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("rejects an out-of-allowlist recipient on the first save too, not only on a re-edit", async () => {
    // Criterion 6 reads "on both create and edit", and in the BFF those are ONE route: the agent
    // persists the draft with `recipient: null` (`email_policy.build_persisted_draft` discards the
    // address the model proposed), so the analyst's first save is the create — a PUT at revision 0
    // against a draft that has no recipient yet. There is no second entry point to check, and the
    // interesting half of the criterion is that the check does not somehow depend on an existing
    // address being present to compare against.
    const res = await putDraft({
      recipient: "ap@attacker.example",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 0,
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not an allowed/i);
    expect(editDraft).not.toHaveBeenCalled();

    // …and the allowlisted address at the same revision is stored, so the rejection above is the
    // allowlist talking and not the create shape failing for some unrelated reason.
    editDraft.mockResolvedValue(
      draft({ revision: 1, draft_status: "pending", approved_revision: null }),
    );
    const ok = await putDraft({
      recipient: "ap@counterparty.example",
      subject: "Invoice 42",
      body: "Please confirm.",
      revision: 0,
    });

    expect(ok.status).toBe(200);
    expect(editDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient: "ap@counterparty.example",
        revision: 0,
        editedBy: "analyst@x.com",
      }),
    );
  });

  it("rejects a lookalike of an allowlisted domain", async () => {
    const res = await putDraft({
      recipient: "ap@notcounterparty.example",
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(400);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("requires the revision rather than defaulting it", async () => {
    const res = await putDraft({
      recipient: "ap@counterparty.example",
      subject: "s",
      body: "b",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/revision is required/);
    expect(editDraft).not.toHaveBeenCalled();
  });

  it("requires a subject and a body", async () => {
    const res = await putDraft({
      recipient: "ap@counterparty.example",
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
      recipient: "ap@counterparty.example",
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
      recipient: "ap@counterparty.example",
      subject: "s",
      body: "b",
      revision: 3,
    });
    expect(res.status).toBe(401);
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
      // A body that tries to redirect the mail. It is ignored: the send is assembled from `armed`.
      recipient: "attacker@evil.example",
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
    expect(message.toRecipients).toEqual([
      { emailAddress: { address: armed.recipient } },
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

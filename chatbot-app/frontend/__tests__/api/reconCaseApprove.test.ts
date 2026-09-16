// @vitest-environment node
/**
 * Tests for the case-decision half of `POST /api/recon/cases/[id]` — specifically the two status
 * transitions an approval makes (PROPOSED → APPROVED → RESOLVED) and the internal resolution
 * notification that follows them.
 *
 * The failure mode being pinned is stranding. Run the notification UNWRAPPED between the two
 * transitions and a Graph outage throws out of the middle of the approval: the outer catch answers 502
 * and the case is left at APPROVED. `recon_update_status` will not transition APPROVED again, so every
 * retry answers "case is no longer awaiting approval" — and APPROVED is a valid queue filter, so the
 * case stays visible while being unreachable. What is pinned here is that the case reaches its
 * terminal state first, that a failed courtesy mail is reported rather than swallowed or allowed to
 * undo the decision, and that a transition the state machine refuses is reported with the status the
 * case is ACTUALLY in.
 *
 * The node environment is deliberate, for the same reason as `reconEmailDraft.test.ts`: the route
 * imports `authorizeRequest`, which pulls in `jose`, and jsdom's cross-realm `Uint8Array` makes it
 * throw before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CASES_TABLE = "recon-dev-cases";
process.env.GRAPH_MAILBOX = "shared@operator.example";
// An ID, not an address. The route holds no address at all — it resolves this id against the contacts
// table on every send, which is what the mock below stands in for.
process.env.NOTIFY_CONTACT_ID = "notify-primary";
process.env.RECON_GATEWAY_URL = "https://gw.example/mcp";
process.env.EMAIL_CONFIRMATION_TOKEN = "tok-123";

const ddbSend = vi.fn();
const callGatewayTool = vi.fn();
const authorizeRequest = vi.fn();
const recordLessonMemoryEvent = vi.fn();
const resolveContactAddress = vi.fn();

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
vi.mock("@/lib/reconMemory", () => ({ recordLessonMemoryEvent }));
vi.mock("@/lib/rescoreAgreement", () => ({ rescoreAgreement: vi.fn() }));
// Mocked rather than left real: the real reader would issue its GetItem through the DynamoDB mock
// above and read back whichever case row was last seeded, so the notification's recipient would
// silently depend on unrelated fixtures. A real class for ContactUnavailable because a deactivated
// contact has to travel as a notification failure, not as a 502.
vi.mock("@/lib/contactStore", () => ({
  ContactUnavailable: class ContactUnavailable extends Error {
    constructor(message: string) {
      super(message);
      this.name = "ContactUnavailable";
    }
  },
  resolveContactAddress,
}));
vi.mock("@/lib/emailDraftStore", () => ({
  DraftConflict: class DraftConflict extends Error {},
  editDraft: vi.fn(),
  approveDraft: vi.fn(),
  revokeDraftApproval: vi.fn(),
  discardDraft: vi.fn(),
  armSend: vi.fn(),
  markSent: vi.fn(),
}));

const { marshall } = await import("@aws-sdk/util-dynamodb");
const { POST } = await import("@/app/api/recon/cases/[id]/route");

const params = { params: Promise.resolve({ id: "i-1" }) };

const postCase = (body: unknown) =>
  POST(
    new Request("http://x/api/recon/cases/i-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    params,
  );

/** Seed the PROPOSED case row `getCase` reads. No draft — this is the plain approve path. */
function seedCase(over: Record<string, unknown> = {}) {
  ddbSend.mockResolvedValue({
    Item: marshall(
      {
        item_id: "i-1",
        status: "PROPOSED",
        domain: "loan_ops",
        class_id: "SHORT_PAY",
        resolution: "Waive the fee",
        confidence: 0.91,
        ...over,
      },
      { removeUndefinedValues: true },
    ),
  });
}

/** The `new_status` of every status-tool call, in order. */
function transitions(): string[] {
  return (callGatewayTool.mock.calls as Array<[string, { new_status: string }]>)
    .filter(([tool]) => tool === "recon-status___recon_update_status")
    .map(([, args]) => args.new_status);
}

/**
 * Answer every gateway call normally except the status tool, which reports `transitioned` per
 * `verdicts` in call order (a missing entry means `true`).
 */
function statusTransitions(verdicts: boolean[]): void {
  let seen = 0;
  callGatewayTool.mockImplementation(async (tool: string) => {
    if (tool !== "recon-status___recon_update_status") return {};
    const verdict = verdicts[seen++] ?? true;
    return { structuredContent: { transitioned: verdict } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authorizeRequest.mockResolvedValue({ ok: true, subject: "analyst@x.com" });
  resolveContactAddress.mockResolvedValue("ops@operator.example");
  callGatewayTool.mockResolvedValue({
    structuredContent: { transitioned: true },
  });
});

describe("POST /api/recon/cases/[id] — approve, resolve, notify", () => {
  it("resolves and notifies, reporting no notification error", async () => {
    seedCase();
    const res = await postCase({ action: "approve", comment: "agreed" });

    expect(res.status).toBe(200);
    // No `notification_error` key at all on the happy path — the UI branches on its presence.
    expect(await res.json()).toEqual({ status: "RESOLVED" });
    expect(transitions()).toEqual(["APPROVED", "RESOLVED"]);
    // The recipient came from resolving the configured contact id as an internal_notification, not
    // from any address the route holds. A `counterparty` kind here would let internal status mail
    // reach an outside party.
    expect(resolveContactAddress).toHaveBeenCalledWith({
      contactId: "notify-primary",
      kind: "internal_notification",
    });
    const [, mail] = callGatewayTool.mock.calls.find(
      ([, args]) =>
        (args as Record<string, unknown>).sendPurpose === "notification",
    ) as [
      string,
      { message: { toRecipients: { emailAddress: { address: string } }[] } },
    ];
    expect(mail.message.toRecipients).toEqual([
      { emailAddress: { address: "ops@operator.example" } },
    ]);
  });

  it("still resolves when the resolution notification fails, and says so", async () => {
    seedCase();
    callGatewayTool.mockImplementation(
      async (tool: string, args: Record<string, unknown>) => {
        if (args.sendPurpose === "notification")
          throw new Error("Graph 5xx: mailbox unavailable");
        return { structuredContent: { transitioned: true } };
      },
    );

    const res = await postCase({ action: "approve", comment: "agreed" });

    // The decision stands and the case is closed. Returning 502 here — as the unwrapped version
    // did — would invite a retry that cannot work, because the case is already terminal.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "RESOLVED",
      notification_error: "Graph 5xx: mailbox unavailable",
    });
    // The stranding itself: RESOLVED was reached, so the case is not parked at APPROVED.
    expect(transitions()).toEqual(["APPROVED", "RESOLVED"]);
    // And the failed courtesy mail did not cost the approval its lesson.
    expect(recordLessonMemoryEvent).toHaveBeenCalledWith(
      expect.objectContaining({ item_id: "i-1", trigger: "USER_APPROVED" }),
    );
  });

  it("sends the notification only after the case is RESOLVED", async () => {
    seedCase();
    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(200);
    // Ordering is load-bearing, not an incidental detail: anything between APPROVED and RESOLVED that
    // can throw can strand the case, because APPROVED has no retry path through this route.
    const order = (
      callGatewayTool.mock.calls as Array<[string, Record<string, unknown>]>
    ).map(([tool, args]) =>
      tool === "recon-status___recon_update_status"
        ? String(args.new_status)
        : String(args.sendPurpose ?? tool),
    );
    expect(order).toEqual(["APPROVED", "RESOLVED", "notification"]);
  });

  it("reports APPROVED, not RESOLVED, when the resolve transition is refused", async () => {
    seedCase();
    statusTransitions([true, false]);

    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(502);
    const payload = await res.json();
    // The honest state. Answering `{status: "RESOLVED"}` would tell the analyst the case is closed
    // when it is sitting at APPROVED, and answering the generic 409 would suggest a retry.
    expect(payload.status).toBe("APPROVED");
    expect(payload.error).toMatch(/could not be moved to RESOLVED/);
    expect(payload.error).toMatch(/needs an operator/);
    // Nothing was mailed about a resolution that did not happen.
    expect(
      callGatewayTool.mock.calls.filter(
        ([, args]) => (args as Record<string, unknown>).sendPurpose,
      ),
    ).toHaveLength(0);
  });

  it("409s without notifying when the case is no longer awaiting approval", async () => {
    seedCase();
    statusTransitions([false]);

    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer awaiting approval/);
    expect(transitions()).toEqual(["APPROVED"]);
    expect(
      callGatewayTool.mock.calls.filter(
        ([, args]) => (args as Record<string, unknown>).sendPurpose,
      ),
    ).toHaveLength(0);
  });

  it("resolves without a notification when no notify contact is configured", async () => {
    // A deployment that seeded no contact is a supported configuration, and it must not be the
    // reason a case fails to close.
    const notify = process.env.NOTIFY_CONTACT_ID;
    process.env.NOTIFY_CONTACT_ID = "";
    vi.resetModules();
    const { POST: freshPost } =
      await import("@/app/api/recon/cases/[id]/route");
    seedCase();

    const res = await freshPost(
      new Request("http://x/api/recon/cases/i-1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      }),
      params,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "RESOLVED" });
    expect(
      callGatewayTool.mock.calls.filter(
        ([, args]) => (args as Record<string, unknown>).sendPurpose,
      ),
    ).toHaveLength(0);
    expect(resolveContactAddress).not.toHaveBeenCalled();
    process.env.NOTIFY_CONTACT_ID = notify;
  });

  it("resolves and reports the reason when the notify contact was deactivated", async () => {
    // Deactivating the contact in the Config tab must stop the mail WITHOUT stranding the case: the
    // resolution stands, and the failed courtesy mail is reported rather than swallowed. This is the
    // whole point of resolving an id at send time instead of baking an address into the deployment.
    seedCase();
    const { ContactUnavailable } = await import("@/lib/contactStore");
    resolveContactAddress.mockRejectedValue(
      new ContactUnavailable(
        "contact notify-primary is deactivated and cannot be sent to",
      ),
    );

    const res = await postCase({ action: "approve" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "RESOLVED",
      notification_error:
        "contact notify-primary is deactivated and cannot be sent to",
    });
    // No send was attempted at all — the address never existed to address it to.
    expect(
      callGatewayTool.mock.calls.filter(
        ([, args]) => (args as Record<string, unknown>).sendPurpose,
      ),
    ).toHaveLength(0);
  });
});

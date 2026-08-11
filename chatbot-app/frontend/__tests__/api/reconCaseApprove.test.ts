// @vitest-environment node
/**
 * Tests for the case-decision half of `POST /api/recon/cases/[id]` — specifically the two status
 * transitions an approval makes (PROPOSED → APPROVED → RESOLVED) and the internal resolution
 * notification that follows them.
 *
 * These exist because of a stranding defect. The notification used to run UNWRAPPED between the two
 * transitions, so a Graph outage threw out of the middle of the approval: the outer catch answered
 * 502 and the case was left at APPROVED. `recon_update_status` will not transition APPROVED again,
 * so every retry answered "case is no longer awaiting approval" — and APPROVED is a valid queue
 * filter, so the case stayed visible while being unreachable. What is pinned here is that the case
 * reaches its terminal state first, that a failed courtesy mail is reported rather than swallowed or
 * allowed to undo the decision, and that a transition the state machine refuses is reported with the
 * status the case is ACTUALLY in.
 *
 * The node environment is deliberate, for the same reason as `reconEmailDraft.test.ts`: the route
 * imports `authorizeRequest`, which pulls in `jose`, and jsdom's cross-realm `Uint8Array` makes it
 * throw before any assertion runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.CASES_TABLE = "recon-dev-cases";
process.env.GRAPH_MAILBOX = "shared@operator.example";
process.env.RECON_NOTIFY_EMAIL = "ops@operator.example";
process.env.RECON_GATEWAY_URL = "https://gw.example/mcp";
process.env.EMAIL_CONFIRMATION_TOKEN = "tok-123";

const ddbSend = vi.fn();
const callGatewayTool = vi.fn();
const authorizeRequest = vi.fn();
const recordLessonMemoryEvent = vi.fn();

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
    // Ordering is the fix, not an incidental detail: anything between APPROVED and RESOLVED that
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

  it("resolves without a notification when the mail is not configured", async () => {
    // A deployment with no notify address is a supported configuration, and it must not be the
    // reason a case fails to close.
    const notify = process.env.RECON_NOTIFY_EMAIL;
    process.env.RECON_NOTIFY_EMAIL = "";
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
    process.env.RECON_NOTIFY_EMAIL = notify;
  });
});

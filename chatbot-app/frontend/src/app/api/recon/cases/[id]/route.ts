import { NextResponse } from "next/server";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { unmarshall, marshall } from "@aws-sdk/util-dynamodb";
import { recordLessonMemoryEvent, type LessonEvent } from "@/lib/reconMemory";
import { callGatewayTool } from "@/lib/gatewayMcp";
import { rescoreAgreement } from "@/lib/rescoreAgreement";
import { authorizeRequest } from "@/lib/api-auth";
import { ContactUnavailable, resolveContactAddress } from "@/lib/contactStore";
import {
  DraftConflict,
  approveDraft,
  armSend,
  discardDraft,
  markSent,
  revokeDraftApproval,
  type PersistedDraft,
} from "@/lib/emailDraftStore";

// Same-origin BFF: get a single case, and drive the approve/disapprove workflow. Reads/writes
// DynamoDB via the ECS task role. This is where the deployed UI's decisions actually run.
//   approve  → send the approved counterparty draft (if any), email the configured recipient
//              (Microsoft Graph, from the shared mailbox via the egress gateway tool), then
//              RESOLVED (+ approval lesson)
//   reject   → require a correction comment + outcome:
//                no_action → CLOSED_NO_ACTION (terminal)
//                reprocess → store correction, re-invoke agent, IN_PROGRESS (capped)
//   approve_draft / revoke_draft / discard_draft
//            → the counterparty email draft's own lifecycle; no case transition. The draft's text
//              is edited through `./draft` (PUT); everything here decides its fate at a pinned
//              revision.
export const runtime = "nodejs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const CASES_TABLE = process.env.CASES_TABLE ?? "recon-dev-cases";
const LESSONS_TABLE = process.env.LESSONS_TABLE ?? "recon-lessons";
// WHO the internal resolution mail goes to, as an id rather than an address. The address lives only
// in the contacts table and is looked up at the moment of sending, so deactivating that contact stops
// the notification without a redeploy. An empty value means the deploy seeded no contact, which is
// the one case where skipping the notification entirely is correct.
const NOTIFY_CONTACT_ID = process.env.NOTIFY_CONTACT_ID ?? "";
const GRAPH_MAILBOX = process.env.GRAPH_MAILBOX ?? "";
const RECON_GATEWAY_URL = process.env.RECON_GATEWAY_URL ?? "";
const AGENT_RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN ?? "";
const REPROCESS_CAP = parseInt(process.env.REPROCESS_CAP ?? "3", 10);
const AGENT_WORKER_FUNCTION = process.env.AGENT_WORKER_FUNCTION ?? "";

// Execute a persisted proposed_action (the escalated case's deferred write) THROUGH the
// egress gateway's set_draw_status tool, so the same server-side guards that bind the agent
// bind the human path: Cedar Policy (the principal-scoped human-approve permit — this call
// carries no confidence) and the gateway-layer provenance check. Throws on any gateway/tool
// error so the caller keeps the case PROPOSED and surfaces the failure — an approval must
// never silently fail to act.
async function executeProposedAction(
  action: Record<string, unknown>,
): Promise<void> {
  // Persisted actions carry a `tool` discriminator that is not part of the tool's schema.
  const { tool: _tool, ...args } = action;
  await callGatewayTool("set-draw-status___set_draw_status", args);
}

function ddb() {
  return new DynamoDBClient({ region: REGION });
}

// Send the resolution notification FROM the shared mailbox via the egress gateway's
// microsoft-graph___sendSharedMailboxMail tool (SigV4-signed with the task role — see
// lib/gatewayMcp). Throws on any gateway/Graph error so approve fails loudly.
//
// The recipient is resolved here, from NOTIFY_CONTACT_ID, on every send. A deactivated contact throws
// ContactUnavailable and the mail does not go out — which is the whole reason the address is not held
// in an environment variable: an operator revokes a recipient in the Config tab and the next send
// already obeys. The gateway interceptor resolves the same id independently and compares, so a wrong
// answer here produces a denial rather than mail to the wrong inbox.
async function sendResolutionEmail(
  id: string,
  c: Record<string, unknown>,
  approveComment: string,
): Promise<void> {
  const recipient = await resolveContactAddress({
    contactId: NOTIFY_CONTACT_ID,
    kind: "internal_notification",
  });
  await callGatewayTool("microsoft-graph___sendSharedMailboxMail", {
    mailboxAddress: GRAPH_MAILBOX,
    message: {
      subject: `[Recon] Resolved: ${id} (${c.domain ?? ""})`,
      body: {
        contentType: "Text",
        content:
          `Case ${id} approved & resolved.\n\nDomain: ${c.domain ?? ""}\n` +
          `Class: ${c.class_id ?? ""}\nResolution: ${c.resolution ?? ""}\n` +
          `Confidence: ${c.confidence ?? ""}\n` +
          (approveComment ? `Approver comment: ${approveComment}\n` : ""),
      },
      toRecipients: [{ emailAddress: { address: recipient } }],
    },
    saveToSentItems: true,
    // Human-confirmation token: this send only runs after the analyst clicked Approve, so it
    // carries the confirmation the gateway interceptor requires. The agent runtime has no token
    // and thus cannot send email autonomously. Stripped by the interceptor before reaching Graph.
    confirmationToken: process.env.EMAIL_CONFIRMATION_TOKEN ?? "",
    // What this send IS: internal status mail to the operator's own team. The interceptor checks the
    // sole recipient against the ACTIVE internal_notification contacts in the same table this route
    // just read, so this branch cannot reach anyone the operator has not listed — mail to a
    // counterparty goes through the `counterparty` purpose, which requires an approved draft on the
    // case. An absent or unknown purpose is denied, so this field is not optional. Stripped before
    // reaching Graph.
    //
    // "notification" is the PURPOSE on the wire; "internal_notification" above is the contact KIND.
    // The two are deliberately different words for different things, and the interceptor only knows
    // the purpose — renaming this to match the kind denies every notification send.
    sendPurpose: "notification",
  });
}

// Send the approved counterparty email — the one message in this system that leaves the operator.
//
// The text comes from `draft`, which is the row the conditional arm-write just returned, never from
// the request: the gateway interceptor re-reads the same row and refuses the send unless the
// recipient, subject and body match it exactly at the approved revision. Passing request-supplied
// text here would simply produce a denial, which is the point — there is no path from an HTTP body
// to a counterparty's inbox.
//
// The ADDRESS is the exception, because no row holds one: `draft.recipient` is NULL for the life of
// the draft. It is resolved here from `recipient_contact_id`, out of the operator's contact table, so
// that deactivating a contact makes an already-approved draft unsendable without anyone touching the
// case. The interceptor resolves the same id again, on its own, and compares the two — so a wrong
// answer here is a denial, not a misdirected email.
async function sendCounterpartyEmail(
  id: string,
  draft: PersistedDraft,
): Promise<void> {
  const recipient = await resolveContactAddress({
    contactId: draft.recipient_contact_id,
    kind: "counterparty",
  });
  await callGatewayTool("microsoft-graph___sendSharedMailboxMail", {
    mailboxAddress: GRAPH_MAILBOX,
    message: {
      subject: draft.subject,
      body: { contentType: "Text", content: draft.body },
      toRecipients: [{ emailAddress: { address: recipient } }],
    },
    saveToSentItems: true,
    confirmationToken: process.env.EMAIL_CONFIRMATION_TOKEN ?? "",
    // What this send IS: mail to an outside party. The interceptor checks the recipient against
    // COUNTERPARTY_EMAIL_DOMAINS and the whole message against the approved draft on this case.
    sendPurpose: "counterparty",
    // Which case's draft authorizes it. Without this the interceptor has nothing to compare
    // against and denies the send.
    reconItemId: id,
  });
}

// Decision-comment requirement mode from SSM: "required" | "optional" | "disapprove-only".
// Cached briefly; fail-safe to the default mode.
const COMMENT_REQ_PARAM =
  process.env.COMMENT_REQUIREMENT_PARAM ?? "/recon-dev/comment-requirement";
let _commentMode: { value: string; at: number } | null = null;
async function commentMode(): Promise<string> {
  if (_commentMode && Date.now() - _commentMode.at < 60_000)
    return _commentMode.value;
  let value = "disapprove-only";
  try {
    const { SSMClient, GetParameterCommand } =
      await import("@aws-sdk/client-ssm");
    const got = await new SSMClient({ region: REGION }).send(
      new GetParameterCommand({ Name: COMMENT_REQ_PARAM }),
    );
    const v = (got.Parameter?.Value ?? "").trim().toLowerCase();
    if (["required", "optional", "disapprove-only"].includes(v)) value = v;
  } catch {
    /* default stands */
  }
  _commentMode = { value, at: Date.now() };
  return value;
}

async function recordLesson(fields: Record<string, unknown>) {
  // Idempotent per (item_id, trigger). Best-effort: a lessons write must never block the decision.
  try {
    await ddb().send(
      new PutItemCommand({
        TableName: LESSONS_TABLE,
        Item: marshall(
          {
            lesson_id: `${fields.item_id}#${fields.trigger}`,
            created_at: new Date().toISOString(),
            ...fields,
          },
          { removeUndefinedValues: true },
        ),
      }),
    );
  } catch {
    /* lessons capture is best-effort; the decision already stands */
  }
  // Also feed AgentCore Memory (lessons_learned semantic strategy) so the agent can recall
  // this decision on future similar items. Best-effort as well.
  await recordLessonMemoryEvent(fields as unknown as LessonEvent);
  // Re-score analyst agreement for this case's latest session, detached — online eval
  // scored it BEFORE this decision existed (permanent ABSTAIN otherwise). Never blocks
  // or fails the decision.
  if (typeof fields.item_id === "string") {
    void rescoreAgreement(fields.item_id);
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const resp = await ddb().send(
      new GetItemCommand({
        TableName: CASES_TABLE,
        Key: { item_id: { S: id } },
      }),
    );
    if (!resp.Item)
      return NextResponse.json({ error: "not found" }, { status: 404 });
    const row = unmarshall(resp.Item);
    // Some rows carry `item` as a JSON string rather than a map — normalize before returning.
    if (typeof row.item === "string") {
      try {
        row.item = JSON.parse(row.item);
      } catch {
        /* leave as-is */
      }
    }
    return NextResponse.json(row);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

// Guarded, audited case-lifecycle transition via the PLATFORM-ONLY recon_update_status
// gateway tool: the state machine (can_transition), race-safe conditional write, and the
// audit row are enforced server-side, and Cedar permits this tool exclusively for platform
// principals (the agent roles are forbidden). Returns false when the state machine
// disallows the transition — callers surface that as a 409 conflict.
async function updateStatus(
  id: string,
  status: string,
  opts?: { comment?: string; actor?: string },
): Promise<boolean> {
  const result = await callGatewayTool("recon-status___recon_update_status", {
    item_id: id,
    new_status: status,
    ...(opts?.comment ? { comment: opts.comment } : {}),
    actor: opts?.actor ?? "bff",
  });
  // Lambda targets surface their return value as structuredContent or as JSON text content.
  const structured = result.structuredContent as
    { transitioned?: boolean } | undefined;
  if (structured && typeof structured.transitioned === "boolean")
    return structured.transitioned;
  const first = (result.content as Array<{ text?: string }> | undefined)?.[0];
  if (first?.text) {
    try {
      return Boolean(JSON.parse(first.text).transitioned);
    } catch {
      /* fall through */
    }
  }
  // No parseable payload but the tool did not error — treat as applied.
  return true;
}

async function getCase(id: string): Promise<Record<string, unknown> | null> {
  const resp = await ddb().send(
    new GetItemCommand({ TableName: CASES_TABLE, Key: { item_id: { S: id } } }),
  );
  return resp.Item ? unmarshall(resp.Item) : null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    comment?: string;
    outcome?: string;
    /** The draft revision the analyst is acting on — pinned, never defaulted. */
    draft_revision?: number;
    /** Explicit human override for a draft whose earlier send outcome is unknown. */
    override_unknown_send?: boolean;
  };
  const c = await getCase(id);
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });
  const draft = (c.proposed_email as PersistedDraft | undefined) ?? null;

  try {
    const mode = await commentMode();

    // --- draft lifecycle: approve / revoke / discard the counterparty email ---------------------
    // These three change only the draft, never the case status, so they are handled before the
    // case-decision actions and share one identity lookup and one revision check.
    if (
      body.action === "approve_draft" ||
      body.action === "revoke_draft" ||
      body.action === "discard_draft"
    ) {
      // `src/proxy.ts` authorized the request but does not hand the subject down, and who approved
      // outbound mail to an outside party is exactly the thing that must not be self-reported.
      const auth = await authorizeRequest(req);
      if (!auth.ok)
        return NextResponse.json(
          { error: auth.message },
          { status: auth.status },
        );
      if (!draft)
        return NextResponse.json(
          { error: "this case has no email draft" },
          { status: 404 },
        );
      const revision = Number(body.draft_revision);
      if (!Number.isInteger(revision) || revision < 0)
        return NextResponse.json(
          {
            error:
              "draft_revision is required and must be a non-negative integer",
          },
          { status: 400 },
        );
      try {
        const updated =
          body.action === "approve_draft"
            ? await approveDraft({ id, revision, approvedBy: auth.subject })
            : body.action === "revoke_draft"
              ? await revokeDraftApproval({ id, revision, actor: auth.subject })
              : await discardDraft({ id, revision, discardedBy: auth.subject });
        return NextResponse.json({ proposed_email: updated });
      } catch (draftErr) {
        if (draftErr instanceof DraftConflict)
          return NextResponse.json(
            { error: draftErr.message },
            { status: 409 },
          );
        throw draftErr;
      }
    }

    if (body.action === "approve") {
      const approveComment = (body.comment ?? "").trim();
      if (mode === "required" && !approveComment)
        return NextResponse.json(
          { error: "a comment is required by configuration" },
          { status: 400 },
        );
      // A draft still awaiting a decision blocks the case decision. RESOLVED is terminal, so
      // approving the case now would leave the draft permanently unsendable while the case reads as
      // successfully closed — the same reason auto-resolution refuses these cases outright.
      // `discarded` and `sent` need nothing further: one says the analyst chose not to write, the
      // other that the mail already went (a retried approve lands here and must not re-send).
      //
      // `render_failed` counts as undecided too. The agent meant to write to the counterparty and the
      // template it cited would not render, so the case closing silently over it is exactly the
      // outcome to avoid: the mail was intended, never sent, and nobody said so. The analyst edits it
      // (supplying their own text) or discards it, and either way the record shows which.
      if (
        draft &&
        (draft.draft_status === "pending" ||
          draft.draft_status === "render_failed")
      )
        return NextResponse.json(
          {
            error:
              "this case has an email draft awaiting a decision — approve or discard the draft first",
          },
          { status: 409 },
        );
      const sendingDraft = draft?.draft_status === "approved";
      // Checked BEFORE the ledger write, so a stale approval cannot leave a write applied behind a
      // 409. The revision the analyst is approving must be the one still on the row.
      const draftRevision = Number(body.draft_revision);
      if (sendingDraft) {
        if (!Number.isInteger(draftRevision) || draftRevision < 0)
          return NextResponse.json(
            {
              error:
                "draft_revision is required when approving a case with an approved email draft",
            },
            { status: 400 },
          );
        if (draftRevision !== Number(draft?.revision))
          return NextResponse.json(
            {
              error:
                `the draft changed while you were working on it (it is now revision ` +
                `${draft?.revision}, you sent ${draftRevision}) — reload the case`,
            },
            { status: 409 },
          );
        // Pre-flight the recipient contact, before anything is written. The send resolves it again
        // for real, from the armed row; this is here because `armSend` stamps `send_attempted_at`
        // and a failure after that stamp reads as "we do not know whether it went out" and needs a
        // human override to retry. A contact deactivated hours ago is not an unknown outcome, and
        // making the analyst clear that flag for it would teach them to click through the one warning
        // that must stay meaningful.
        try {
          await resolveContactAddress({
            contactId: String(draft?.recipient_contact_id ?? ""),
            kind: "counterparty",
          });
        } catch (contactErr) {
          const unavailable = contactErr instanceof ContactUnavailable;
          return NextResponse.json(
            {
              error: unavailable
                ? `this case's email draft cannot be sent: ${(contactErr as Error).message}`
                : (contactErr as Error).message,
              status: "PROPOSED",
            },
            { status: unavailable ? 409 : 502 },
          );
        }
      }
      // Deferred execution: if the escalated case carries a structured proposed_action,
      // perform the write NOW (before resolving). A failure keeps the case PROPOSED and
      // returns an error — approving must not resolve a case whose action didn't apply.
      const proposedAction = c.proposed_action as Record<
        string,
        unknown
      > | null;
      if (proposedAction) {
        try {
          await executeProposedAction(proposedAction);
        } catch (execErr) {
          // No status was changed yet — the case is still PROPOSED for a retry.
          return NextResponse.json(
            { error: (execErr as Error).message, status: "PROPOSED" },
            { status: 502 },
          );
        }
      }
      // The counterparty email: after the ledger write, before any status change. It is the only
      // outward-facing, irreversible act in this flow, so it goes last among the things that can
      // fail — and the case stays PROPOSED if it does, which is what makes the retry safe.
      if (sendingDraft) {
        try {
          const armed = await armSend({
            id,
            revision: draftRevision,
            allowRetry: body.override_unknown_send === true,
          });
          await sendCounterpartyEmail(id, armed);
          await markSent(id);
        } catch (sendErr) {
          const conflict = sendErr instanceof DraftConflict;
          return NextResponse.json(
            { error: (sendErr as Error).message, status: "PROPOSED" },
            { status: conflict ? 409 : 502 },
          );
        }
      }
      const approved = await updateStatus(id, "APPROVED", {
        comment: approveComment || undefined,
        actor: "analyst",
      });
      if (!approved)
        return NextResponse.json(
          { error: "case is no longer awaiting approval" },
          { status: 409 },
        );
      // Reach the terminal state BEFORE the notification, and never let the notification fail the
      // request. An unwrapped send between APPROVED and RESOLVED strands the case permanently: a
      // Graph outage throws, the outer catch returns 502, and the case is left at APPROVED — which
      // the status tool will not transition again, so every retry answers "case is no longer awaiting
      // approval" and the case is unreachable from the UI.
      //
      // Ordering the two this way is safe precisely because this mail is NOT the deliverable: the
      // interceptor pins its sole recipient to an active internal_notification contact, so it is
      // internal status mail. The outward-facing counterparty send is the deliverable, and it still runs
      // before any status change with the case held at PROPOSED if it fails.
      const resolved = await updateStatus(id, "RESOLVED");
      if (!resolved)
        // APPROVED with no way forward is the stranding this block exists to prevent, so say so
        // with the real state rather than reporting a resolution that did not happen.
        return NextResponse.json(
          {
            error:
              "the case was approved but could not be moved to RESOLVED; it is APPROVED and " +
              "needs an operator to complete the transition",
            status: "APPROVED",
          },
          { status: 502 },
        );
      // Best-effort, but never silent: the decision stands and the case is closed, so a failed
      // courtesy mail is reported alongside the resolution instead of masking it or undoing it.
      let notificationError: string | null = null;
      if (NOTIFY_CONTACT_ID && GRAPH_MAILBOX && RECON_GATEWAY_URL) {
        try {
          await sendResolutionEmail(id, c, approveComment);
        } catch (notifyErr) {
          // The contact id, never the address: this string reaches CloudWatch, and a resolved
          // recipient in a log is a copy of the operator's contact list outside the table that owns
          // it. A deactivated or missing contact throws here too, so the id is what identifies it.
          notificationError = (notifyErr as Error).message;
          console.error(
            `[Recon] case ${id} resolved, but the resolution notification to contact ` +
              `${NOTIFY_CONTACT_ID} failed: ${notificationError}`,
          );
        }
      }
      await recordLesson({
        item_id: id,
        domain: c.domain ?? "unknown",
        class_id: c.class_id ?? "unknown",
        trigger: "USER_APPROVED",
        user_comment: approveComment || undefined,
        prior_recommendation: c.resolution,
      });
      return NextResponse.json({
        status: "RESOLVED",
        ...(notificationError ? { notification_error: notificationError } : {}),
      });
    }

    if (body.action === "retry") {
      // Recovery for a run that will never finish on its own: re-drive the same item through the
      // agent-worker (honors the runtime⇄harness backend switch).
      //   IN_PROGRESS — the run looks stuck but nothing proved it died; status is unchanged.
      //   FAILED      — the worker proved it died. Move the case back to IN_PROGRESS FIRST, via the
      //                 guarded status tool, so the queue reflects the re-investigation and a second
      //                 failure has an IN_PROGRESS row to mark FAILED again. Doing it after the
      //                 invoke would race the worker's own write.
      // Uncapped on purpose: every retry is an explicit analyst click, so there is no loop to cap
      // (unlike reject→reprocess, which the platform drives).
      if (c.status !== "IN_PROGRESS" && c.status !== "FAILED")
        return NextResponse.json(
          { error: "retry applies only to IN_PROGRESS or FAILED cases" },
          { status: 409 },
        );
      if (!AGENT_WORKER_FUNCTION)
        return NextResponse.json(
          { error: "agent worker is not configured" },
          { status: 500 },
        );
      if (c.status === "FAILED") {
        const reopened = await updateStatus(id, "IN_PROGRESS", {
          comment:
            (body.comment ?? "").trim() || "retry after a failed investigation",
          actor: "analyst",
        });
        if (!reopened)
          return NextResponse.json(
            { error: "case can no longer be retried" },
            { status: 409 },
          );
      }
      const item = (c.item as Record<string, unknown>) ?? { item_id: id };
      const { LambdaClient, InvokeCommand } =
        await import("@aws-sdk/client-lambda");
      await new LambdaClient({ region: REGION }).send(
        new InvokeCommand({
          FunctionName: AGENT_WORKER_FUNCTION,
          InvocationType: "Event",
          Payload: new TextEncoder().encode(
            JSON.stringify({
              agent_arn: AGENT_RUNTIME_ARN,
              item,
              session_id:
                `recon-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-retry-${Date.now()}`.padEnd(
                  33,
                  "0",
                ),
            }),
          ),
        }),
      );
      return NextResponse.json({ status: "IN_PROGRESS", retried: true });
    }

    if (body.action === "cancel") {
      // Analyst cancels a stuck investigation: IN_PROGRESS -> CLOSED_NO_ACTION (terminal),
      // via the guarded platform status tool (audited).
      const cancelled = await updateStatus(id, "CLOSED_NO_ACTION", {
        comment: (body.comment ?? "").trim() || "cancelled by analyst",
        actor: "analyst",
      });
      if (!cancelled)
        return NextResponse.json(
          { error: "case can no longer be cancelled" },
          { status: 409 },
        );
      return NextResponse.json({ status: "CLOSED_NO_ACTION" });
    }

    if (body.action === "reject") {
      const comment = (body.comment ?? "").trim();
      if (mode !== "optional" && !comment)
        return NextResponse.json(
          { error: "correction comment required" },
          { status: 400 },
        );
      if (body.outcome !== "no_action" && body.outcome !== "reprocess")
        return NextResponse.json(
          { error: "outcome must be no_action or reprocess" },
          { status: 400 },
        );
      const rejected = await updateStatus(id, "REJECTED", {
        comment,
        actor: "analyst",
      });
      if (!rejected)
        return NextResponse.json(
          { error: "case is no longer awaiting a decision" },
          { status: 409 },
        );
      await recordLesson({
        item_id: id,
        domain: c.domain ?? "unknown",
        class_id: c.class_id ?? "unknown",
        trigger: "USER_CORRECTION",
        disposition: body.outcome.toUpperCase(),
        user_comment: comment,
        prior_recommendation: c.resolution,
      });

      if (body.outcome === "no_action") {
        await updateStatus(id, "CLOSED_NO_ACTION", { actor: "analyst" });
        return NextResponse.json({ status: "CLOSED_NO_ACTION" });
      }

      // reprocess: persist the correction on the item, then re-invoke (capped to avoid loops)
      const item = (c.item as Record<string, unknown>) ?? {};
      const attrs = { ...((item.attributes as Record<string, unknown>) ?? {}) };
      const count = (Number(attrs.reprocess_count) || 0) + 1;
      attrs.user_correction = comment;
      attrs.reprocess_count = count;
      item.attributes = attrs;
      await ddb().send(
        new UpdateItemCommand({
          TableName: CASES_TABLE,
          Key: { item_id: { S: id } },
          UpdateExpression: "SET #it = :it",
          ExpressionAttributeNames: { "#it": "item" },
          // Write as a DynamoDB MAP — stringifying here corrupted the item shape and hid the
          // IDP document panel after a reprocess.
          ExpressionAttributeValues: marshall(
            { ":it": item },
            { removeUndefinedValues: true },
          ),
        }),
      );
      if (count > REPROCESS_CAP) {
        await updateStatus(id, "AGED", { comment: "reprocess cap reached" });
        return NextResponse.json({ status: "AGED", reason: "reprocess cap" });
      }
      // Re-invoke the recon agent with the correction in the item context — via the
      // agent-worker Lambda so the runtime⇄harness backend switch (AGENT_BACKEND SSM) is
      // respected; a direct InvokeAgentRuntime here would silently pin the runtime backend.
      if (AGENT_WORKER_FUNCTION) {
        await updateStatus(id, "IN_PROGRESS", { comment: "reprocess" });
        const { LambdaClient, InvokeCommand } =
          await import("@aws-sdk/client-lambda");
        await new LambdaClient({ region: REGION }).send(
          new InvokeCommand({
            FunctionName: AGENT_WORKER_FUNCTION,
            InvocationType: "Event", // async — the agent run outlives this request
            Payload: new TextEncoder().encode(
              JSON.stringify({
                agent_arn: AGENT_RUNTIME_ARN,
                item,
                // AgentCore session ids must match [a-zA-Z0-9][a-zA-Z0-9-_]* — sanitize the
                // filename-derived item id (dots, '#', …).
                session_id:
                  `recon-${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-reprocess-${count}`.padEnd(
                    33,
                    "0",
                  ),
              }),
            ),
          }),
        );
      }
      return NextResponse.json({ status: "IN_PROGRESS" });
    }

    return NextResponse.json({ error: "unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 502 },
    );
  }
}

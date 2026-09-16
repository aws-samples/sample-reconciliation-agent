"""Auto-resolution of high-confidence proposals (straight-through processing).

An admin sets a confidence threshold in the Config tab (stored in SSM). After the agent
persists a proposal, if the COMPUTED evidence-completeness confidence meets the threshold the case takes
the full approve path unattended: PROPOSED -> APPROVED -> notification email (marked
AUTO-RESOLVED) -> RESOLVED, plus an AUTO_RESOLVED lesson for the audit trail. Anything below
the threshold stays PROPOSED for human review. Threshold "off" disables auto-resolution.

Confidence is necessary but not sufficient: a case carrying an unsent counterparty email draft is
never auto-resolved at any confidence, because the send needs a human and RESOLVED is terminal.
"""

import logging
import os
from typing import Optional

from backend.recon_core.errors import ToolDenied
from backend.recon_core.cases import CaseStore
from backend.recon_core.lessons import LessonStore
from backend.recon_core.schema import Proposal, ReasoningStep
from backend.recon_core.status import CaseStatus

logger = logging.getLogger(__name__)


def autonomous_execute(
    *, proposal: Proposal, threshold: Optional[float], invoker, now: str = ""
) -> str:
    """Perform the proposed write autonomously when confidence clears the threshold.

    The gate is the COMPUTED evidence-completeness confidence vs. the admin threshold — never the model's
    self-reported number. Below threshold, threshold disabled, or no clean ``proposed_action``
    (e.g. no unambiguous ledger match) ⇒ the item halts unactioned and escalates for human
    review. A write failure also escalates (the case stays PROPOSED) with the error recorded.

    Mutates ``proposal.steps`` with an ``execute`` trace entry on any execution attempt.

    :param invoker: ``callable(action: dict) -> result`` performing the write (Gateway/direct).
        Must raise on failure; a returned dict carrying an ``error`` key is also treated as a
        failure (``denied: true`` ⇒ escalate as a denial), never as a completed write.
    :param now: ISO timestamp for the entry (injected; caller-supplied in prod).
    :returns: ``"executed"`` (write done — caller may auto-resolve), ``"failed"`` (write raised
        — escalate), or ``"escalated"`` (gate not met / nothing to execute — no write attempted).
    """
    if threshold is None or proposal.confidence < threshold:
        return "escalated"
    action = proposal.proposed_action
    if not action:
        return "escalated"  # non-executable — never auto-act without a clean action
    # Pass the COMPUTED evidence-completeness score as the tool's `confidence` input so the AgentCore
    # Policy can gate on context.input.confidence. Cedar compares Longs (no float literals), so
    # send an INTEGER PERCENT in [0..100]; the Cedar policy gates `>= threshold*100`. App-side we
    # already checked the threshold; the policy is the independent hard guardrail (defense in depth).
    # NOTE: must be a FLOAT so JSON carries a decimal point ("100.0") — the gateway types
    # context.input.confidence as a Cedar decimal and rejects bare integers ("Parameter format
    # error: numeric parameters must include a decimal point").
    invocation = {**action, "confidence": float(int(round(float(proposal.confidence) * 100)))}
    try:
        result = invoker(invocation)
        # "The invoker did not raise" is NOT proof the ledger was written. A transport that degrades
        # a failure into a returned {"error": ...} dict — which is what an anyio-wrapped denial looks
        # like coming out of gateway_mcp — would otherwise read as a successful write and auto-resolve
        # the case with nothing behind it. Treat a result carrying an error as the failure it is.
        if isinstance(result, dict) and result.get("error"):
            if result.get("denied"):
                raise ToolDenied(str(result["error"]))
            raise RuntimeError(str(result["error"]))
    except ToolDenied as exc:
        # The gateway policy refused the call (confidence below the Cedar threshold). Escalate.
        proposal.steps.append(
            ReasoningStep(
                skill="execute",
                kind="execute",
                reasoning="Gateway policy denied the write (confidence below threshold); escalating.",
                action=action,
                outcome=f"escalated: policy denied ({exc})",
            )
        )
        logger.info("policy denied autonomous execution for %s: %s", proposal.item_id, exc)
        return "escalated"
    except Exception as exc:  # noqa: BLE001 - a failed write must escalate, never resolve
        proposal.steps.append(
            ReasoningStep(
                skill="execute",
                kind="execute",
                reasoning="Autonomous execution failed; escalating for human review.",
                action=action,
                outcome=f"failed: {exc}",
            )
        )
        logger.warning("autonomous execution failed for %s: %s", proposal.item_id, exc)
        return "failed"
    proposal.steps.append(
        ReasoningStep(
            skill="execute",
            kind="execute",
            reasoning=f"Executed {action.get('tool')} on {action.get('reference')} "
            f"→ {action.get('status')}.",
            action=action,
            outcome="executed",
        )
    )
    return "executed"


def get_threshold(param_name: str, *, ssm=None) -> Optional[float]:
    """Read the auto-resolve threshold from SSM.

    :param param_name: SSM parameter name ('' disables).
    :param ssm: injectable SSM client.
    :returns: threshold in [0, 1], or None when disabled / unset / unreadable (fail-SAFE:
        no threshold means every case gets human review).
    """
    if not param_name:
        return None
    try:
        if ssm is None:
            import boto3

            ssm = boto3.client("ssm")
        raw = ssm.get_parameter(Name=param_name)["Parameter"]["Value"].strip().lower()
        if raw == "off":
            return None
        value = float(raw)
        return value if 0.0 <= value <= 1.0 else None
    except Exception as exc:  # noqa: BLE001 - fail-safe toward human review
        logger.warning("auto-resolve threshold read failed (%s): %s", param_name, exc)
        return None


def maybe_auto_resolve(
    *, cases: CaseStore, proposal: Proposal, threshold: Optional[float], transport=None
) -> bool:
    """Take the full approve path unattended when confidence meets the threshold.

    :param cases: case store (already holds the PROPOSED case).
    :param proposal: the persisted proposal (``confidence`` is the computed evidence completeness).
    :param threshold: admin threshold, or None when auto-resolution is disabled.
    :param transport: injectable gateway tool-call transport for the notification email
        (``callable(tool_name, arguments) -> result``); None uses the live SigV4 MCP call.
    :returns: True if the case was auto-resolved; False if it remains for human review — below
        threshold, auto-resolution disabled, carrying an unsent email draft, or already moved on by
        another writer.
    """
    if threshold is None or proposal.confidence < threshold:
        return False
    # A counterparty draft needs a human to supply the recipient and approve the text, and RESOLVED
    # is terminal — auto-resolving here would strand the draft permanently unsendable while the case
    # reads as successfully closed. The bar for straight-through processing is "nothing left to do";
    # an unsent draft is something left to do. Both callers invoke this on a proposal the agent just
    # produced, so the draft is always `pending` at this point — hence the plain truthiness check
    # rather than a status comparison that could never be exercised.
    if proposal.proposed_email:
        logger.info("auto-resolve skipped for %s: carries an unsent email draft", proposal.item_id)
        return False

    item_id = proposal.item_id
    # Guarded transitions — if another writer moved the case, we simply stop.
    if not cases.transition("item_id", item_id, CaseStatus.APPROVED):
        return False

    # Notification email — same as a human approval, marked as automatic. Best-effort.
    # Sent from the shared mailbox via the microsoft-graph gateway tool (no SES).
    mailbox = os.environ.get("GRAPH_MAILBOX", "")
    # A contact id, not an address — the address is looked up at send time so deactivating the
    # recipient in the console stops the mail on the next case, without a redeploy.
    contact_id = os.environ.get("NOTIFY_CONTACT_ID", "")
    if mailbox and contact_id:
        try:
            from backend.cases.notify import send_resolution_email

            send_resolution_email(
                {
                    "item_id": item_id,
                    "domain": "",
                    "class_id": f"{proposal.class_id} (AUTO-RESOLVED)",
                    "resolution": proposal.resolution,
                    "confidence": str(proposal.confidence),
                },
                mailbox=mailbox,
                contact_id=contact_id,
                transport=transport,
            )
        except LookupError as exc:
            # The contact was deactivated, deleted, or is not an internal_notification contact. The
            # resolution still stands — but say which contact failed, because the alternative is an
            # operator inferring a missing notification from silence.
            logger.warning(
                "auto-resolve notification skipped for %s: contact %s is unusable: %s",
                item_id,
                contact_id,
                exc,
            )
        except Exception as exc:  # noqa: BLE001 - email must not block resolution
            logger.warning("auto-resolve email failed for %s: %s", item_id, exc)

    cases.transition("item_id", item_id, CaseStatus.RESOLVED)

    # Lesson for the audit trail / future recall — best-effort.
    lessons_table = os.environ.get("LESSONS_TABLE", "")
    if lessons_table:
        try:
            LessonStore(table=lessons_table).record(
                item_id=item_id,
                domain="unknown",
                class_id=proposal.class_id,
                trigger="AUTO_RESOLVED",
                disposition=f"confidence {proposal.confidence:.2f} >= threshold {threshold:.2f}",
                prior_recommendation=proposal.resolution,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("auto-resolve lesson write failed for %s: %s", item_id, exc)

    logger.info(
        "auto-resolved %s (confidence %.3f >= threshold %.2f)",
        item_id,
        proposal.confidence,
        threshold,
    )
    return True

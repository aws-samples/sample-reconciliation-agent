"""Lambda ``<name_prefix>-pipeline-parser``: parse one received email into a staged deal.

Invoked asynchronously by the BFF with ``{"email_id": ...}``. The email record is moved
RECEIVED -> PARSING -> PARSED (with a new deal record and its staging CSV) or -> PARSE_FAILED with
the error text. The handler never leaves an email in PARSING: every failure after that transition is
caught, recorded on the email and returned rather than raised, because an async Lambda retry would
only re-run the same failure. That includes running out of time: the model loop is given a
deadline 20 s short of the Lambda's remaining time, so a slow model ends as PARSE_FAILED instead
of the runtime killing the process with the email stuck in PARSING.

A re-parse supersedes what the previous parse staged: any deal of this email still open (STAGED,
APPROVED, UPLOAD_FAILED) is moved to REJECTED with a history entry naming the new deal, so the
stale record cannot be approved by mistake. Deals already UPLOADED or REJECTED are left as they are.

Environment:

- ``EMAILS_TABLE``, ``DEALS_TABLE``   DynamoDB tables (design section 4); the deals table's
                                      ``by_email`` index is queried on re-parse.
- ``ASSETS_BUCKET``                   S3 bucket holding skills, prompts, security master, CSVs.
- ``KNOWLEDGE_MEMORY_ID``             AgentCore Memory id for edge-case recall ("" disables).
- ``MEMORY_NAMESPACE``                default ``deal-pipeline/edge-cases/deal-desk``.
- ``AGENT_MODEL_PARAM``               SSM parameter with the model id, read through
                                      ``recon_core.model_select``: unset, unreadable or off the
                                      allowlist falls back to the default.
- ``SKILLS_PREFIX``                   default ``skills/``.
- ``PARSER_PROMPT_KEY``               default ``prompts/parser-system.md``.
- ``SECURITY_MASTER_PREFIX``          default ``security-master/``.
- ``DESK_TZ``                         IANA zone for Date Arrived; default ``America/New_York``.
"""

import logging
import os
import secrets
import time
from datetime import UTC, datetime

import boto3
from boto3.dynamodb.conditions import Key

from backend.deal_pipeline.agent import DEFAULT_DESK_TZ, DEFAULT_SYSTEM_PROMPT, parse_email
from backend.deal_pipeline.memory_recall import retrieve_rules
from backend.deal_pipeline.oms_schema import to_csv
from backend.deal_pipeline.security_master import SecurityMaster
from backend.deal_pipeline.skills_loader import list_skills, load_text, select_skills
from backend.recon_core.ddb_update import update_attributes, utc_now_iso
from backend.recon_core.model_select import get_agent_model_id

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-5"
DEFAULT_MEMORY_NAMESPACE = "deal-pipeline/edge-cases/deal-desk"
# Memory recall query: the subject plus the opening of the body, which is where a notice states
# the borrower, facility and use of proceeds -- the attributes edge-case rules are conditioned on.
MEMORY_QUERY_BODY_CHARS = 600
PARSER_ACTOR = "parser"
BY_EMAIL_INDEX = "by_email"
# Deal statuses a reviewer can still act on (mirrors the BFF's isOpen); these are what a re-parse
# must retire so the stale record is not approved instead of the fresh one.
OPEN_DEAL_STATUSES = ("STAGED", "APPROVED", "UPLOAD_FAILED")
# Time kept back from the Lambda's remaining budget so the failure path itself (logging, the
# PARSE_FAILED write) always completes before the runtime stops the process.
DEADLINE_MARGIN_SECONDS = 20.0


def new_deal_id(now: datetime | None = None) -> str:
    """``dl_<UTC timestamp>_<4 hex>``: sortable by creation time, unique enough for a demo."""
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%S")
    return f"dl_{stamp}_{secrets.token_hex(2)}"


def parse_deadline(context, clock=time.monotonic) -> float | None:
    """A ``time.monotonic()`` deadline for the model loop, or None when no Lambda context exists.

    :param context: the Lambda context (anything with ``get_remaining_time_in_millis``); None or
        an object without it (tests, local runs) means no deadline.
    """
    remaining = getattr(context, "get_remaining_time_in_millis", None)
    if remaining is None:
        return None
    return clock() + remaining() / 1000.0 - DEADLINE_MARGIN_SECONDS


def supersede_open_deals(deals, email_id: str, new_deal_id: str, now: str) -> list[str]:
    """Move this email's still-open deals to REJECTED because a fresh parse is about to be staged.

    Queries the ``by_email`` index (no Scan). UPLOADED deals are history the OMS already has and
    REJECTED ones are already closed, so both are left alone.

    :returns: the superseded deal ids, oldest first as the index returns them.
    """
    superseded = []
    kwargs = {"IndexName": BY_EMAIL_INDEX, "KeyConditionExpression": Key("email_id").eq(email_id)}
    while True:
        page = deals.query(**kwargs)
        for item in page.get("Items", []):
            if item.get("status") not in OPEN_DEAL_STATUSES or item["deal_id"] == new_deal_id:
                continue
            update_attributes(
                deals,
                {"deal_id": item["deal_id"]},
                {"status": "REJECTED", "updated_at": now},
                append={
                    "history": [
                        {
                            "at": now,
                            "actor": PARSER_ACTOR,
                            "action": "REJECTED",
                            "detail": f"superseded by {new_deal_id}",
                        }
                    ]
                },
            )
            superseded.append(item["deal_id"])
        if "LastEvaluatedKey" not in page:
            return superseded
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def build_deal(
    email: dict, parse: dict, deal_id: str, created_at: str, supersedes: list[str] | None = None
) -> dict:
    """Assemble the deal record of design section 4 from an email and its ParseOutput.

    :param supersedes: ids of the email's earlier open deals this one replaces (named in history).
    """
    detail = f"Parsed with {parse['model_id']} in {parse['duration_ms']} ms"
    if supersedes:
        detail += "; supersedes " + ", ".join(supersedes)
    return {
        "deal_id": deal_id,
        "email_id": email["email_id"],
        "opportunity_name": parse["fields"].get("opportunity_name", ""),
        "status": "STAGED",
        "fields": dict(parse["fields"]),
        "original_fields": dict(parse["fields"]),
        "evidence": parse["evidence"],
        "assumptions": parse["assumptions"],
        "memory_hits": parse["memory_hits"],
        "skills_used": parse["skills_used"],
        "enrichment": parse["enrichment"],
        "csv_key": f"deal-csv/{deal_id}.csv",
        "upload": None,
        "history": [
            {
                "at": created_at,
                "actor": PARSER_ACTOR,
                "action": "STAGED",
                "detail": detail,
            }
        ],
        "created_at": created_at,
        "updated_at": created_at,
    }


def handle(event, context=None, *, bedrock=None, agentcore=None) -> dict:
    """Parse the email named by ``event["email_id"]``; return ``{email_id, deal_id, status}``.

    :param event: ``{"email_id": str}``.
    :param context: Lambda context; its remaining time bounds the model loop (see
        :func:`parse_deadline`). None runs without a deadline.
    :param bedrock: ``bedrock-runtime`` client override (tests); built by the agent when None.
    :param agentcore: ``bedrock-agentcore`` client override (tests); built lazily when None.
    :raises KeyError: when the email does not exist -- that is a caller error, and the email has
        not been moved to PARSING, so raising is safe.
    """
    email_id = event["email_id"]
    dynamodb = boto3.resource("dynamodb")
    emails = dynamodb.Table(os.environ["EMAILS_TABLE"])
    deals = dynamodb.Table(os.environ["DEALS_TABLE"])
    s3 = boto3.client("s3")
    bucket = os.environ["ASSETS_BUCKET"]

    email = emails.get_item(Key={"email_id": email_id}).get("Item")
    if email is None:
        raise KeyError(f"email {email_id} not found")
    update_attributes(
        emails,
        {"email_id": email_id},
        {"status": "PARSING", "error": None, "updated_at": utc_now_iso()},
    )

    try:
        model_id = get_agent_model_id(
            os.environ.get("AGENT_MODEL_PARAM", ""), default=DEFAULT_MODEL_ID
        )
        system_prompt = load_text(
            s3,
            bucket,
            os.environ.get("PARSER_PROMPT_KEY", "prompts/parser-system.md"),
            DEFAULT_SYSTEM_PROMPT,
        )
        skills = select_skills(
            list_skills(s3, bucket, os.environ.get("SKILLS_PREFIX", "skills/")),
            email.get("source_kind"),
        )
        security_master = SecurityMaster.from_s3(
            s3, bucket, os.environ.get("SECURITY_MASTER_PREFIX", "security-master/")
        )
        memories = retrieve_rules(
            os.environ.get("KNOWLEDGE_MEMORY_ID", ""),
            os.environ.get("MEMORY_NAMESPACE", DEFAULT_MEMORY_NAMESPACE),
            f"{email.get('subject', '')}\n{(email.get('body') or '')[:MEMORY_QUERY_BODY_CHARS]}",
            client=agentcore,
        )
        parse = parse_email(
            email,
            model_id=model_id,
            system_prompt=system_prompt,
            skills=skills,
            memories=memories,
            security_master=security_master,
            bedrock=bedrock,
            deadline=parse_deadline(context),
            desk_tz=os.environ.get("DESK_TZ", DEFAULT_DESK_TZ),
        )

        created_at = utc_now_iso()
        deal_id = new_deal_id()
        superseded = supersede_open_deals(deals, email_id, deal_id, created_at)
        if superseded:
            logger.info("email %s: superseded open deals %s", email_id, superseded)
        deal = build_deal(email, parse, deal_id, created_at, supersedes=superseded)
        s3.put_object(
            Bucket=bucket,
            Key=deal["csv_key"],
            Body=to_csv(deal["fields"]).encode("utf-8"),
            ContentType="text/csv",
        )
        deals.put_item(Item=deal)
        update_attributes(
            emails,
            {"email_id": email_id},
            {
                "status": "PARSED",
                "deal_id": deal["deal_id"],
                "parse": parse,
                "error": None,
                "updated_at": created_at,
            },
        )
        return {"email_id": email_id, "deal_id": deal["deal_id"], "status": "PARSED"}
    except Exception as exc:  # noqa: BLE001 - recorded on the email; see module docstring
        logger.exception("parse failed for email %s", email_id)
        message = f"{type(exc).__name__}: {exc}"[:2000]
        update_attributes(
            emails,
            {"email_id": email_id},
            {"status": "PARSE_FAILED", "error": message, "updated_at": utc_now_iso()},
        )
        return {"email_id": email_id, "deal_id": None, "status": "PARSE_FAILED", "error": message}

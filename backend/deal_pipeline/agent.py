"""Parsing agent: a Bedrock Converse tool-use loop that turns one deal email into a ``ParseOutput``.

Plain boto3, no framework. The model gets two tools: ``lookup_security_master`` (issuer
enrichment) and ``stage_deal`` (the structured result: every OMS field, per-field evidence and
assumptions). Skills and recalled edge-case memories go in the first user turn, ahead of the email,
so a skill edit or a saved memory changes the very next parse.

Model output is treated as untrusted text: after ``stage_deal`` the fields are normalized against
the schema, values that miss the OMS format are run through the ``coerce`` helpers for their type
(``S+200`` in a percent field becomes ``2.000%``), and whatever still fails is sent back to the model
ONCE as a correction turn. Values failing after that are blanked, and each blanking is recorded as
an assumption so the reviewer sees it. Nothing the model *writes* raises. What does raise, so the
handler can record PARSE_FAILED instead of staging a hollow record: transport errors, a reply cut
off at ``maxTokens`` (:class:`ModelOutputTruncated`) and running out of Lambda time (``TimeoutError``).

Output shape: ``docs/deal-pipeline-design.md`` section 4 (``ParseOutput``).
"""

import logging
import re
import time
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from backend.deal_pipeline import coerce
from backend.deal_pipeline.oms_schema import (
    FIELDS,
    apply_defaults,
    by_key,
    format_hint,
    normalize_fields,
    validate_value,
)
from backend.deal_pipeline.security_master import ISSUER_FIELD_MAP, SecurityMaster

logger = logging.getLogger(__name__)

MAX_ROUNDS = 6
LOOKUP_TOOL = "lookup_security_master"
STAGE_TOOL = "stage_deal"
CONFIDENCE_LEVELS = ("high", "medium", "low")
# 8192 output tokens: a full stage_deal payload (74 field keys, an evidence object with an excerpt
# for every populated field, assumptions) runs to ~3k tokens, and on models with adaptive thinking
# the cap also covers the thinking, so 4096 was reachable. No temperature: current Claude models
# reject it alongside tool use.
INFERENCE_CONFIG = {"maxTokens": 8192}
# botocore's defaults (60 s reads, legacy retries, five attempts) let one slow generation eat the
# whole 300 s Lambda budget inside a single converse() call, where the deadline check below cannot
# run. Two-minute reads and two retries bound each call; standard mode adds jittered backoff.
BEDROCK_CLIENT_CONFIG = {
    "read_timeout": 120,
    "connect_timeout": 10,
    "retries": {"max_attempts": 2, "mode": "standard"},
}
# The desk's zone for turning a UTC timestamp into the calendar date the desk would write down.
DEFAULT_DESK_TZ = "America/New_York"


class ModelOutputTruncated(RuntimeError):
    """The model hit ``maxTokens`` before finishing, so there is no complete stage_deal to trust."""


def desk_zone(name: str) -> ZoneInfo:
    """The desk's zone, falling back to :data:`DEFAULT_DESK_TZ` (then UTC) when ``name`` is unknown.

    A mistyped ``DESK_TZ`` or a runtime without a time-zone database must cost at most a wrong
    calendar date on evening emails, never every parse.
    """
    for candidate in (name, DEFAULT_DESK_TZ):
        try:
            return ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError):
            logger.warning("time zone %r not available; falling back", candidate)
    return UTC


def bedrock_client():
    """A ``bedrock-runtime`` client with :data:`BEDROCK_CLIENT_CONFIG` applied."""
    import boto3
    from botocore.config import Config

    return boto3.client("bedrock-runtime", config=Config(**BEDROCK_CLIENT_CONFIG))


# Used when s3://<assets>/prompts/parser-system.md has not been seeded (or was deleted). Kept
# generic on purpose: the operational rules live in the skills, which the desk edits.
DEFAULT_SYSTEM_PROMPT = """You are the new-issue desk's deal-parsing agent. You read ONE deal email \
(a market news alert or an arranger's launch notice) and stage exactly one record for the OMS \
pipeline by calling the stage_deal tool.

Rules:
- Use only what the email states or what the security master returns. Never invent a value; \
leave a field blank ("") when the email does not support it, and say so in assumptions.
- Every field value must already be in the OMS format described in the tool schema \
(dates M/D/YYYY, times like 12PM or 1:15PM, percents like 2.000%, millions like 500.000, \
prices like 99.500, booleans Yes/No, enums exactly as listed).
- Fields marked as internal desk decisions stay blank; Pipeline Status is New and % Commit is 0.000%.
- For every non-blank field, give evidence: the exact email excerpt the value came from, a \
confidence (high/medium/low) and, when a skill or memory rule decided the value, the rule.
- First call lookup_security_master with the issuer or borrower name, then call stage_deal once \
with the complete set of fields."""


# ---------------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------------


def _field_description(field: dict) -> str:
    """One-line description of a field for the stage_deal schema: label, format, constraints."""
    parts = [field["label"]]
    if field["type"] == "enum":
        parts.append("one of: " + ", ".join(field.get("values") or []))
    elif field["type"] == "string":
        if field.get("pattern"):
            parts.append(f"text matching {field['pattern']}")
        elif field.get("max_length"):
            parts.append(f"text, at most {field['max_length']} characters")
        else:
            parts.append("text")
    else:
        parts.append(f"{field['type']}: {format_hint(field['type'])}")
    if field.get("min") is not None or field.get("max") is not None:
        parts.append(f"range {field.get('min', '')}-{field.get('max', '')}")
    if field.get("required"):
        parts.append("required by the OMS")
    if field.get("source") == "internal":
        parts.append(
            f'internal desk decision: always "{field["default"]}"'
            if "default" in field
            else "internal desk decision: leave blank"
        )
    elif field.get("source") == "lookup":
        parts.append("normally from the security master lookup")
    elif field.get("source") == "post_pricing":
        parts.append("known only after pricing; blank at launch")
    # Deliberately no `notes`: the schema notes restate mappings (covenant numbering, the
    # investment-grade threshold) that the skills leave out so the learning loop can add them.
    # The model must learn those from skills and memories, not from the tool schema.
    return "; ".join(parts)


def tool_config() -> dict:
    """Bedrock Converse ``toolConfig`` with the lookup and stage_deal tools; ``toolChoice: any``.

    The stage_deal input schema is generated from ``oms_fields.json`` so the model sees every
    field's label, format, allowed values and notes without them being repeated in the prompt.
    """
    field_props = {
        f["key"]: {"type": "string", "description": _field_description(f)} for f in FIELDS
    }
    stage_schema = {
        "type": "object",
        "properties": {
            "fields": {
                "type": "object",
                "description": 'Every OMS field key, value already in OMS format, "" when blank.',
                "properties": field_props,
                "required": list(field_props),
            },
            "evidence": {
                "type": "object",
                "description": "Per field key (non-blank fields only): where the value came from.",
                "additionalProperties": {
                    "type": "object",
                    "properties": {
                        "value": {"type": "string"},
                        "confidence": {"type": "string", "enum": list(CONFIDENCE_LEVELS)},
                        "excerpt": {
                            "type": "string",
                            "description": "Exact email text the value was taken from.",
                        },
                        "rule": {
                            "type": "string",
                            "description": "Skill or memory rule applied, when any.",
                        },
                    },
                    "required": ["value", "confidence", "excerpt"],
                },
            },
            "assumptions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Things inferred without direct evidence, and fields left blank and why.",
            },
        },
        "required": ["fields", "evidence", "assumptions"],
    }
    return {
        "tools": [
            {
                "toolSpec": {
                    "name": LOOKUP_TOOL,
                    "description": (
                        "Look up an issuer / borrower in the security master. Returns region, "
                        "industry, sponsors, liquidity score and asset id when the issuer is known."
                    ),
                    "inputSchema": {
                        "json": {
                            "type": "object",
                            "properties": {
                                "issuer_name": {
                                    "type": "string",
                                    "description": "Issuer or borrower name as written in the email.",
                                }
                            },
                            "required": ["issuer_name"],
                        }
                    },
                }
            },
            {
                "toolSpec": {
                    "name": STAGE_TOOL,
                    "description": "Stage the parsed deal for review. Call exactly once, with every field.",
                    "inputSchema": {"json": stage_schema},
                }
            },
        ],
        "toolChoice": {"any": {}},
    }


# ---------------------------------------------------------------------------------
# Prompt assembly
# ---------------------------------------------------------------------------------


def build_user_message(
    email: dict, skills: list[dict], memories: list[dict], reference_iso: str
) -> str:
    """First user turn: skills, then advisory memories, then the email, then the instruction.

    Skills come first because they are the universal rules; memories are labelled advisory so
    the model applies one only when its stated condition matches this email.
    """
    sections = []
    for skill in skills:
        sections.append(f"## Skill: {skill['name']}\n{skill.get('body', '').strip()}")
    memory_lines = [f"- {m['text'].strip()}" for m in memories if (m.get("text") or "").strip()]
    sections.append(
        "## Edge-case memories (advisory, apply when their condition matches)\n"
        + ("\n".join(memory_lines) if memory_lines else "none")
    )
    headers = [
        f"From: {email.get('from', '')}",
        f"To: {email.get('to', '')}",
    ]
    if email.get("cc"):
        headers.append(f"Cc: {email['cc']}")
    headers += [
        f"Sent: {email.get('sent', '')}",
        f"Received: {email.get('received_at', '')}",
        f"Subject: {email.get('subject', '')}",
    ]
    if email.get("source_kind"):
        # The system prompt tells the model which format skill it was given and why; the
        # source kind is how it can tell.
        headers.append(f"Source kind: {email['source_kind']}")
    sections.append("## Email\n" + "\n".join(headers) + "\n\n" + (email.get("body") or ""))
    sections.append(
        "## Instructions\n"
        f"Reference date for dates written without a year: {reference_iso[:10]}.\n"
        f"1. Call {LOOKUP_TOOL} with the issuer / borrower name.\n"
        f"2. Then call {STAGE_TOOL} once with every OMS field, evidence for each non-blank field, "
        "and your assumptions."
    )
    return "\n\n".join(sections)


# ---------------------------------------------------------------------------------
# The email's reference instant (year inference and Date Arrived)
# ---------------------------------------------------------------------------------


def email_reference(email: dict, now, desk_tz: str) -> tuple[datetime, str, str]:
    """When the email reached the desk, as an aware datetime whose calendar date is the desk's.

    The first of ``sent``, ``received_at`` and the clock that parses as ISO-8601 wins (a raw API
    caller can get a non-ISO ``sent`` past the BFF's check, and that must not fail the parse).
    Zone handling decides Date Arrived, so it is deliberate:

    - a stamp carrying a non-UTC offset is the sender's own clock and is kept as written;
    - a UTC stamp is the wire form (``toISOString`` in the BFF writes ``received_at`` and any
      ``sent`` it normalized that way) rather than anybody's local time, so it is converted to
      the desk zone: an 8:30 PM Eastern email has a ``received_at`` of 00:30 UTC the next day and
      Date Arrived must not move with it;
    - a stamp with no offset is read as desk-local.

    :param email: the email record.
    :param now: clock returning an aware datetime; used when neither header parses.
    :param desk_tz: IANA zone name of the desk, e.g. ``America/New_York``.
    :returns: ``(instant, excerpt, rule)`` -- the evidence text Date Arrived is recorded with.
    """
    zone = desk_zone(desk_tz)
    for header, label in (("sent", "Sent"), ("received_at", "Received")):
        parsed = coerce.parse_iso(email.get(header))
        if parsed is None:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=zone)
        elif parsed.utcoffset() == timedelta(0):
            parsed = parsed.astimezone(zone)
        rule = (
            "Date Arrived is the calendar date of the Sent header"
            if header == "sent"
            else f"Date Arrived is the email received date in the desk's time zone ({desk_tz})"
        )
        return parsed, f"{label}: {email[header]}", rule
    instant = now().astimezone(zone)
    return instant, f"Parsed at: {instant.isoformat()}", "Date Arrived is the parse date"


# ---------------------------------------------------------------------------------
# Post-processing of stage_deal output
# ---------------------------------------------------------------------------------


def _normalize_evidence(raw) -> dict[str, dict]:
    """Keep evidence for known keys only, with a valid confidence and string members."""
    out = {}
    if not isinstance(raw, dict):
        return out
    for key, item in raw.items():
        if by_key(key) is None:
            continue
        if not isinstance(item, dict):
            item = {"value": item, "excerpt": item}
        entry = {
            "value": "" if item.get("value") is None else str(item.get("value")),
            "confidence": item.get("confidence")
            if item.get("confidence") in CONFIDENCE_LEVELS
            else "low",
            "excerpt": "" if item.get("excerpt") is None else str(item.get("excerpt")),
        }
        if item.get("rule"):
            entry["rule"] = str(item["rule"])
        out[key] = entry
    return out


def _pick_end(pair: tuple[str, str] | None, key: str) -> str | None:
    """A low/high pair goes to the matching end of a ``*_low``/``*_high`` field; single fields take low."""
    if pair is None:
        return None
    return pair[1] if key.endswith("_high") else pair[0]


def _coerce_value(field: dict, value: str, reference_iso: str) -> str | None:
    """Best-effort conversion of a value that failed validation into its field's OMS format."""
    ftype, key = field["type"], field["key"]
    if ftype == "percent":
        return _pick_end(coerce.bps_or_spread_to_percent(value), key)
    if ftype == "price":
        return _pick_end(coerce.oid_to_prices(value), key)
    if ftype == "mm":
        return coerce.money_to_mm(value)
    if ftype == "date":
        return coerce.to_date(value, reference_iso)
    if ftype == "time":
        return coerce.to_time(value)
    if ftype == "boolean":
        return coerce.yes_no(value)
    if ftype == "integer":
        m = re.search(r"\d+", value)
        return m.group(0) if m else None
    if ftype == "enum":
        values = field.get("values") or []
        exact = [v for v in values if v.lower() == value.lower()]
        if exact:
            return exact[0]
        # "First Lien Term Loan B" names exactly one allowed value; two hits stay ambiguous.
        contained = [v for v in values if re.search(rf"(?<!\w){re.escape(v)}(?!\w)", value, re.I)]
        return contained[0] if len(contained) == 1 else None
    if ftype == "string":
        if field.get("pattern"):
            return coerce.tenor_to_terms(value)
        if field.get("max_length") and len(value) > field["max_length"]:
            return value[: field["max_length"]].rstrip()
    return None


def _finalize(staged: dict, reference: tuple[datetime, str, str], match: dict | None) -> dict:
    """Normalize, coerce, enrich and validate one stage_deal payload.

    :param reference: :func:`email_reference` of the email -- year inference and Date Arrived.
    :returns: ``{fields, evidence, assumptions, problems}`` where ``problems`` maps field keys to
        the validation message still outstanding (blank-but-required included).
    """
    reference_instant, reference_excerpt, reference_rule = reference
    reference_iso = reference_instant.isoformat()
    raw_fields = staged.get("fields") if isinstance(staged.get("fields"), dict) else {}
    fields = normalize_fields(raw_fields)
    evidence = _normalize_evidence(staged.get("evidence"))
    raw_assumptions = (
        staged.get("assumptions") if isinstance(staged.get("assumptions"), list) else []
    )
    assumptions = [str(a).strip() for a in raw_assumptions if str(a).strip()]

    # Internal-decision fields belong to the desk (design section 5): every one is forced to its
    # schema default ("" for most, "New" and "0.000%" for the two that have one) whatever the
    # model wrote, because a model-supplied "Pass" or "5.000%" is a desk decision nobody took. The
    # override is recorded once so the reviewer knows the model tried to make it.
    overridden = []
    for f in FIELDS:
        if f.get("source") != "internal":
            continue
        expected = f.get("default", "")
        written = fields[f["key"]].strip()
        if written and written.lower() != expected.lower():
            overridden.append(f["label"])
            evidence.pop(f["key"], None)
        fields[f["key"]] = expected
    if overridden:
        assumptions.append(
            "Reset internal-decision fields the model filled to the desk defaults "
            "(the desk sets these): " + ", ".join(overridden)
        )

    if not fields["date_arrived"].strip():
        # to_date on an ISO stamp keeps its written date, which email_reference already made the
        # desk's calendar date, so this is never a day out from the reference used for years.
        arrived = coerce.to_date(reference_iso, reference_iso)
        if arrived:
            fields["date_arrived"] = arrived
            evidence["date_arrived"] = {
                "value": arrived,
                "confidence": "high",
                "excerpt": reference_excerpt,
                "rule": reference_rule,
            }

    for f in FIELDS:
        key, value = f["key"], fields[f["key"]].strip()
        fields[key] = value
        if not value or validate_value(f, value) is None:
            continue
        fixed = _coerce_value(f, value, reference_iso)
        if fixed is not None and validate_value(f, fixed) is None:
            fields[key] = fixed

    if match:
        for key, column in ISSUER_FIELD_MAP.items():
            master_value = str(match.get(column) or "").strip()
            if fields[key] or not master_value or validate_value(by_key(key), master_value):
                continue
            fields[key] = master_value
            evidence[key] = {
                "value": master_value,
                "confidence": "medium",
                "excerpt": f"security master: {match['issuer_name']}",
                "rule": "security master",
            }

    fields = apply_defaults(fields)
    # Evidence shows the value as staged, not as the model first wrote it ("$500 million" next to
    # "500.000" would read as a disagreement). Blank fields keep the model's value: see parse_email.
    for key, entry in evidence.items():
        if fields[key]:
            entry["value"] = fields[key]
    problems = {}
    for f in FIELDS:
        problem = validate_value(f, fields[f["key"]])
        if problem:
            problems[f["key"]] = problem
    return {
        "fields": fields,
        "evidence": evidence,
        "assumptions": assumptions,
        "problems": problems,
    }


def _correction_prompt(problems: dict[str, str], fields: dict[str, str]) -> str:
    lines = []
    for key, problem in problems.items():
        label = by_key(key)["label"]
        current = fields.get(key, "")
        lines.append(
            f"- {label}: required but blank" if not current else f"- {label}: '{current}' {problem}"
        )
    return (
        "The staged record has values the OMS will reject. Call stage_deal again with the FULL set "
        "of fields, correcting only these (keep every other field exactly as staged):\n"
        + "\n".join(lines)
        + "\nIf the email does not state a value, leave the field blank and add an assumption."
    )


def _tool_result(use: dict, payload: dict, *, error: bool = False) -> dict:
    result = {"toolUseId": use["toolUseId"], "content": [{"json": payload}]}
    if error:
        result["status"] = "error"
    return {"toolResult": result}


def _lookup_payload(match: dict | None, issuer_name: str) -> dict:
    if match is None:
        return {"match": None, "message": f"No security master entry matches '{issuer_name}'."}
    return {"match": {k: v for k, v in match.items() if k != "aliases"}}


def _blank_output(
    model_id: str, skills: list[dict], memories: list[dict], reason: str, started: float
) -> dict:
    return {
        "fields": apply_defaults(normalize_fields({})),
        "evidence": {},
        "assumptions": [reason],
        "memory_hits": _memory_hits(memories),
        "skills_used": [s["name"] for s in skills],
        "enrichment": {"issuer_match": None, "fields_from_security_master": []},
        "model_id": model_id,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }


def _memory_hits(memories: list[dict]) -> list[dict]:
    hits = []
    for m in memories:
        hit = {"text": m.get("text", "")}
        if m.get("record_id"):
            hit["record_id"] = m["record_id"]
        hits.append(hit)
    return hits


# ---------------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------------


def parse_email(
    email: dict,
    *,
    model_id: str,
    system_prompt: str,
    skills: list[dict],
    memories: list[dict],
    security_master: SecurityMaster,
    bedrock=None,
    now=None,
    deadline: float | None = None,
    desk_tz: str | None = None,
) -> dict:
    """Run the tool-use loop for one email and return a ``ParseOutput`` dict (design section 4).

    :param email: the email record (``from, to, cc, subject, sent, received_at, body``).
    :param model_id: Bedrock model id or inference profile.
    :param system_prompt: the parser system prompt text.
    :param skills: ``[{name, description, body}]`` from :mod:`skills_loader`.
    :param memories: ``[{record_id, text}]`` from :mod:`memory_recall`; echoed back as ``memory_hits``.
    :param security_master: issuer reference data behind the lookup tool.
    :param bedrock: boto3 ``bedrock-runtime`` client (injected in tests; :func:`bedrock_client`
        when None).
    :param now: clock returning an aware ``datetime``; only used as the date reference when the
        email carries neither a readable ``sent`` nor ``received_at``.
    :param deadline: ``time.monotonic()`` value after which no further model call is started; the
        handler derives it from the Lambda's remaining time so a slow model fails as PARSE_FAILED
        instead of the runtime killing the process mid-parse. None means no deadline.
    :param desk_tz: IANA zone for Date Arrived (see :func:`email_reference`); the desk default
        when None.
    :returns: the ParseOutput. Evidence ``value`` equals the final field value for fields that
        survived validation; for a field that was blanked, it keeps the model's original value so
        the reviewer can still see what the model read.
    :raises botocore.exceptions.BotoCoreError, ClientError: transport / service failures.
    :raises ModelOutputTruncated: the model stopped at ``maxTokens``; the partial reply is not
        staged, because a cut-off stage_deal looks like an email with nothing in it.
    :raises TimeoutError: the deadline passed before a model round could start.
    """
    started = time.perf_counter()
    clock = now or (lambda: datetime.now(UTC))
    reference = email_reference(email, clock, desk_tz or DEFAULT_DESK_TZ)
    reference_iso = reference[0].isoformat()
    if bedrock is None:
        bedrock = bedrock_client()

    messages = [
        {
            "role": "user",
            "content": [{"text": build_user_message(email, skills, memories, reference_iso)}],
        }
    ]
    config = tool_config()
    match: dict | None = None
    matched_by_pipeline = False
    outcome: dict | None = None
    retried = False

    for round_number in range(1, MAX_ROUNDS + 1):
        if deadline is not None and time.monotonic() >= deadline:
            raise TimeoutError(
                f"out of time before model round {round_number}: the Lambda would be stopped "
                "before the model answered"
            )
        response = bedrock.converse(
            modelId=model_id,
            system=[{"text": system_prompt}],
            messages=messages,
            toolConfig=config,
            inferenceConfig=INFERENCE_CONFIG,
        )
        if response.get("stopReason") == "max_tokens":
            raise ModelOutputTruncated(
                f"model output truncated at {INFERENCE_CONFIG['maxTokens']} output tokens in "
                f"round {round_number}; a partial {STAGE_TOOL} cannot be staged"
            )
        message = (response.get("output") or {}).get("message") or {}
        tool_uses = [c["toolUse"] for c in message.get("content", []) if "toolUse" in c]
        if not tool_uses:
            # toolChoice "any" makes this rare (a truncated reply, mostly); nudge and try again.
            # Converse rejects empty text blocks, so an empty reply is echoed as a placeholder.
            messages.append(
                {"role": "assistant", "content": message.get("content") or [{"text": "(no reply)"}]}
            )
            messages.append(
                {
                    "role": "user",
                    "content": [{"text": f"Call {STAGE_TOOL} now with the fields you have."}],
                }
            )
            continue
        messages.append(message)

        results, staged = [], None
        for use in tool_uses:
            tool_input = use.get("input") if isinstance(use.get("input"), dict) else {}
            if use["name"] == LOOKUP_TOOL:
                issuer_name = str(tool_input.get("issuer_name") or "")
                found = security_master.match_issuer(issuer_name)
                if found:
                    match = found
                results.append(_tool_result(use, _lookup_payload(found, issuer_name)))
            elif use["name"] == STAGE_TOOL:
                staged = tool_input
                results.append(_tool_result(use, {"status": "received"}))
            else:
                results.append(
                    _tool_result(use, {"error": f"unknown tool {use['name']}"}, error=True)
                )

        follow_up = None
        if staged is not None:
            if match is None:
                # The model skipped the lookup; enrich from the email text so the reviewer still
                # gets the security master fields, and be explicit that the pipeline did it.
                match = security_master.match_issuer(
                    f"{email.get('subject', '')}\n{email.get('body', '')}"
                )
                matched_by_pipeline = match is not None
            outcome = _finalize(staged, reference, match)
            if outcome["problems"] and not retried:
                retried = True
                follow_up = _correction_prompt(outcome["problems"], outcome["fields"])
            else:
                break
        content = results + ([{"text": follow_up}] if follow_up else [])
        messages.append({"role": "user", "content": content})

    if outcome is None:
        logger.warning("model never called %s within %d rounds", STAGE_TOOL, MAX_ROUNDS)
        return _blank_output(
            model_id,
            skills,
            memories,
            f"The model did not stage a deal within {MAX_ROUNDS} rounds.",
            started,
        )

    fields, evidence, assumptions = outcome["fields"], outcome["evidence"], outcome["assumptions"]
    if matched_by_pipeline:
        assumptions.append(
            f"Issuer '{match['issuer_name']}' was matched by the pipeline from the email text; "
            f"the model did not call {LOOKUP_TOOL}."
        )
    for key, problem in outcome["problems"].items():
        label = by_key(key)["label"]
        if fields[key]:
            assumptions.append(f"Left {label} blank: '{fields[key]}' {problem}.")
            fields[key] = ""
        else:
            assumptions.append(f"{label} is required but could not be determined from the email.")

    from_master = [
        key
        for key, column in ISSUER_FIELD_MAP.items()
        if match and fields[key] and fields[key] == str(match.get(column) or "").strip()
    ]
    return {
        "fields": fields,
        "evidence": evidence,
        "assumptions": assumptions,
        "memory_hits": _memory_hits(memories),
        "skills_used": [s["name"] for s in skills],
        "enrichment": {
            "issuer_match": match["issuer_name"] if match else None,
            "fields_from_security_master": from_master,
        },
        "model_id": model_id,
        "duration_ms": int((time.perf_counter() - started) * 1000),
    }

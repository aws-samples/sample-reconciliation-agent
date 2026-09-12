"""Collect PENDING cases into an S3 object for the Tier-2 map run to iterate.

Two constraints force this step to exist, and neither is obvious:

* A Distributed Map's ``ItemReader`` reads from **S3 only** (``arn:aws:states:::s3:getObject``). There
  is no DynamoDB source, so the item list has to be materialised somewhere first.
* Even if there were, a Step Functions state payload caps at 256 KB. 5000 item ids with their domains
  do not fit, so passing the list inline would work in testing and fail on the burst it exists for.

It also resolves the agent backend ONCE per run. Reading ``/recon-dev/agent-backend`` per item would be
one SSM call per case, and worse, it would let a single run straddle an operator's mid-run backend
switch — half the items investigated by the runtime container and half by the harness, with nothing in
the run recording that it happened.
"""

import json
import logging
import os

import boto3

logger = logging.getLogger(__name__)

# Hard ceiling on one run. An unbounded Query feeding an unbounded Map is how a bad day becomes a much
# worse one: the map's MaxConcurrency bounds the RATE of investigations but not the total, so a runaway
# backlog would still be attempted in full. Truncation is logged loudly and the remainder is picked up
# by the next run, because the cases stay PENDING.
_DEFAULT_MAX_ITEMS = 5000

# Only these keys go to S3. The full case row carries the proposal, the reasoning steps and the token
# usage, none of which the dispatcher needs -- and all of which would multiply the object size and the
# per-item state payload for nothing.
_PROJECTION = "item_id, #d, created_at"


def _pending_cases(*, table, max_items: int) -> list[dict]:
    """Query the status-index GSI for PENDING cases, oldest first, up to ``max_items``.

    Queries the GSI rather than scanning: ``status`` is its hash key and ``created_at`` its range key
    (``infra/modules/foundation/main.tf``), so this is a single key condition rather than a full-table
    read. Ascending on ``created_at`` means the oldest waiting case is investigated first, which is the
    behaviour an aging queue needs.

    :param table: a boto3 DynamoDB Table resource for the cases table.
    :param max_items: stop after this many, however many more are waiting.
    :returns: a list of ``{"item_id", "domain", "created_at"}`` dicts.
    """
    from boto3.dynamodb.conditions import Key

    from backend.recon_core.session import session_id_for

    out: list[dict] = []
    kwargs: dict = {
        "IndexName": "status-index",
        "KeyConditionExpression": Key("status").eq("PENDING"),
        # `domain` is a DynamoDB reserved word, hence the alias.
        "ProjectionExpression": _PROJECTION,
        "ExpressionAttributeNames": {"#d": "domain"},
        "ScanIndexForward": True,
    }
    while True:
        resp = table.query(**kwargs)
        for row in resp.get("Items", []):
            item_id = str(row.get("item_id", ""))
            out.append(
                {
                    "item_id": item_id,
                    "domain": str(row.get("domain", "")),
                    # Computed HERE, not in ASL. `States.Format('recon-{}', item_id)` looks equivalent
                    # and is not: AgentCore requires [a-zA-Z0-9][a-zA-Z0-9-_]* and at least 33
                    # characters, while real item ids carry dots and '#'. An invalid session id
                    # surfaces as a per-invocation runtime error that looks nothing like a naming bug.
                    "session_id": session_id_for(item_id),
                }
            )
            if len(out) >= max_items:
                logger.warning(
                    "collected the %d-item ceiling; more PENDING cases remain and will be picked up "
                    "by the next run (they stay PENDING)",
                    max_items,
                )
                return out
        token = resp.get("LastEvaluatedKey")
        if not token:
            return out
        kwargs["ExclusiveStartKey"] = token


def _another_run_in_flight(*, execution_name: str) -> bool:
    """Is another execution of this state machine already running?

    ⚠️ This is what keeps the concurrency bound global. ``MaxConcurrency`` is enforced **per Map Run**,
    not per state machine, so two overlapping runs each get their own full allowance and together
    exceed the Bedrock token budget by exactly the factor of how many overlap. With a short schedule
    and investigations that outlast it, overlap is the normal case rather than the exceptional one:
    a 5-minute cadence against runs measured at ~57s each but thousands of items long would stack
    many runs deep, and the cap would silently mean nothing.

    Single-flight is enforced here rather than by the schedule because the schedule cannot know how
    long a run takes. Any RUNNING execution other than this one counts — including a previous run's
    Distributed Map children, which are executions of this same state machine and are precisely the
    evidence that the earlier run has not finished.

    Fails CLOSED on a read error: if we cannot tell, assume a run is in flight and collect nothing.
    Skipping one cycle costs five minutes; guessing wrong the other way multiplies the token budget.

    :param execution_name: this execution's name, excluded from the check.
    :returns: True when another run is in flight, or when the check could not be made.
    """
    arn = os.environ.get("STATE_MACHINE_ARN", "")
    if not arn:
        # Unwired: the guard cannot work, and silently proceeding would remove the global bound.
        logger.error(
            "STATE_MACHINE_ARN is unset; refusing to collect without the single-flight guard"
        )
        return True
    try:
        sfn = boto3.client("stepfunctions")
        paginator = sfn.get_paginator("list_executions")
        for page in paginator.paginate(stateMachineArn=arn, statusFilter="RUNNING"):
            for ex in page.get("executions", []):
                if ex.get("name") != execution_name:
                    logger.warning(
                        "another Tier-2 run is already in flight (%s); collecting nothing so the "
                        "concurrency bound stays global",
                        ex.get("name"),
                    )
                    return True
    except Exception as exc:  # noqa: BLE001 - see the docstring: fail closed
        logger.error("could not check for in-flight runs (%s); assuming one is running", exc)
        return True
    return False


def handle(event, _context):
    """Write the PENDING case list to S3 and return the map run's input pointer.

    Collects nothing when another run is already in flight — see :func:`_another_run_in_flight`, which
    is what keeps ``MaxConcurrency`` a global bound rather than a per-run one.

    :param event: ``{"execution_name": str}`` — used to key the S3 object so concurrent runs cannot
        overwrite each other's input, and to exclude this execution from the in-flight check.
    :param _context: the Lambda context (unused).
    :returns: ``{"bucket", "key", "count", "backend"}``. A ``count`` of 0 is a normal, expected
        outcome and the state machine short-circuits on it.
    :raises KeyError: when ``execution_name`` is absent. Deriving a fallback key would let two runs
        silently share one input object.
    """
    execution_name = event["execution_name"]
    if _another_run_in_flight(execution_name=execution_name):
        return {"bucket": "", "key": "", "count": 0, "backend": "", "skipped": "run_in_flight"}
    bucket = os.environ["RUNS_BUCKET"]
    prefix = os.environ.get("RUNS_PREFIX", "tier2-runs/")
    max_items = int(os.environ.get("MAX_ITEMS_PER_RUN", _DEFAULT_MAX_ITEMS))

    ddb = boto3.resource("dynamodb")
    table = ddb.Table(os.environ.get("CASES_TABLE", "recon-cases"))
    items = _pending_cases(table=table, max_items=max_items)

    # One read per run, stamped onto the run's output so every child inherits the same answer. See the
    # module docstring for why this is not per-item.
    from backend.recon_core.model_select import get_agent_backend

    backend = get_agent_backend(os.environ.get("AGENT_BACKEND_PARAM", ""))

    key = f"{prefix}{execution_name}.json"
    boto3.client("s3").put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps(items).encode(),
        ContentType="application/json",
    )
    logger.info(
        "collected %d PENDING case(s) for backend=%s at s3://%s/%s",
        len(items),
        backend,
        bucket,
        key,
    )
    return {"bucket": bucket, "key": key, "count": len(items), "backend": backend}

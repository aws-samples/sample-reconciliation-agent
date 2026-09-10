"""Deploy-time actions Terraform cannot express declaratively, run in-account by a Lambda.

⚠️ WHY THIS EXISTS

Some steps of an apply are genuinely imperative: readiness waits on asynchronous service
validation, and one-shot API calls with no corresponding resource. The declarative-looking way to run
them is a `local-exec` provisioner shelling out to the AWS CLI, and it makes an apply depend on the CLI
(and its bundled botocore version) being present on whatever machine ran Terraform. On a build image we
do not control, that is not a thing that can be relied on — hence a Lambda, running in-account.

Each action is invoked synchronously by `aws_lambda_invocation`, so it runs at apply time in
dependency order and its failure fails the apply.

⚠️ THIS FUNCTION MUST NOT BE PACKAGED BY infra/modules/lambda-package.

That module vendors pip wheels into a staging directory that `data.archive_file` reads at PLAN
time, which is the single largest reason a plan needs local tooling. This handler is deliberately
dependency-free — stdlib plus the boto3 that the Lambda runtime already provides — so its zip is
built straight from this directory by `archive_file` with nothing to install. Adding a third-party
import here reintroduces the problem this function exists to remove.

⚠️ FAIL LOUDLY. Every action raises on a terminal state or a timeout rather than returning
something that reads as success. A silent pass here is worse than a failed apply: it leaves a
knowledge base with no documents, or a Cedar policy validated against an empty tool surface, and
both of those present as "the feature works, it just never finds anything".
"""

from __future__ import annotations

import time
from typing import Any, Callable

import boto3

import seed_push

# Poll budgets. Each mirrors the provisioner it replaces, so the observable behaviour of an apply
# does not change. Lambda's hard ceiling is 15 minutes, which every budget here stays inside.
DATA_SOURCE_ATTEMPTS = 30
DATA_SOURCE_INTERVAL = 20  # 10 minutes
TARGET_ATTEMPTS = 60
TARGET_INTERVAL = 10  # 10 minutes
INGESTION_ATTEMPTS = 60
INGESTION_INTERVAL = 10  # 10 minutes


def _poll(
    *,
    describe: Callable[[], dict],
    ready: str,
    terminal: tuple[str, ...],
    attempts: int,
    interval: int,
    label: str,
    status_key: Callable[[dict], str],
    detail: Callable[[dict], Any] = lambda _: None,
    sleeper: Callable[[float], None] | None = None,
) -> dict:
    """Poll ``describe`` until ``ready``, raising on a terminal status or on timeout.

    :param describe: zero-arg callable returning the describe/get response.
    :param ready: status value that means success.
    :param terminal: status values that are failures — raise immediately rather than waiting out
        the budget, because a FAILED resource never becomes ready.
    :param attempts: maximum number of polls.
    :param interval: seconds between polls.
    :param label: human-readable subject, used in log lines and error messages.
    :param status_key: extracts the status string from the response.
    :param detail: extracts diagnostic detail (failure reasons) for the error message.
    :param sleeper: sleep function; defaults to ``time.sleep`` resolved AT CALL TIME. A default of
        ``sleeper=time.sleep`` in the signature would bind the original function when this module is
        imported, so patching ``time.sleep`` afterwards would have no effect — which made a
        timeout-path unit test sleep out the whole real budget instead of returning instantly.
    :returns: the final response dict.
    :raises RuntimeError: on a terminal status or when the budget is exhausted.
    """
    sleep = sleeper if sleeper is not None else time.sleep
    for _ in range(attempts):
        response = describe()
        status = status_key(response)
        print(f"  {label}: {status}")
        if status == ready:
            return response
        if status in terminal:
            # The status alone says nothing useful — an IAM gap or a wrong id only surfaces in the
            # reasons field, so include it in the exception rather than making someone go look.
            raise RuntimeError(f"{label} reached {status}; detail: {detail(response)}")
        sleep(interval)
    raise RuntimeError(
        f"timed out after {attempts * interval}s waiting for {label} to reach {ready}"
    )


def wait_kb_data_source(*, knowledge_base_id: str, data_source_id: str, **_: Any) -> dict:
    """Block until a managed-KB data source is AVAILABLE.

    ⚠️ Load-bearing. CreateDataSource is ASYNCHRONOUS for a managed KB: the data source sits in
    CREATING for ~2-5 minutes, and an ingestion job started before then fails. The Terraform
    resource returns as soon as the API accepts the call, so nothing else establishes this wait.

    :param knowledge_base_id: the managed knowledge base id.
    :param data_source_id: the data source id to wait on.
    :returns: {"status": "AVAILABLE"}.
    """
    client = boto3.client("bedrock-agent")
    _poll(
        describe=lambda: client.get_data_source(
            knowledgeBaseId=knowledge_base_id, dataSourceId=data_source_id
        ),
        ready="AVAILABLE",
        terminal=("FAILED", "DELETING", "DELETE_UNSUCCESSFUL"),
        attempts=DATA_SOURCE_ATTEMPTS,
        interval=DATA_SOURCE_INTERVAL,
        label=f"managed KB data source {data_source_id}",
        status_key=lambda r: r["dataSource"]["status"],
        detail=lambda r: r["dataSource"].get("failureReasons"),
    )
    return {"status": "AVAILABLE"}


def wait_gateway_target(*, gateway_identifier: str, target_id: str, **_: Any) -> dict:
    """Block until a gateway target is READY.

    ⚠️ Not belt-and-braces. Target validation is asynchronous (~30s) and CloudFormation's create
    handler is not documented to wait for it, so a stack can report CREATE_COMPLETE while the
    gateway's tool surface is still empty.

    That matters because AgentCore Policy validates every Cedar action name against the LIVE tool
    surface. Naming an action whose tool is not yet visible fails with "unrecognized action" and
    leaves the policy in UPDATE_FAILED — and Cedar fails closed, so one broken read policy costs the
    agent EVERY read tool, not just the one being added.

    :param gateway_identifier: gateway id the target belongs to.
    :param target_id: the target id to wait on.
    :returns: {"status": "READY"}.
    """
    client = boto3.client("bedrock-agentcore-control")
    _poll(
        describe=lambda: client.get_gateway_target(
            gatewayIdentifier=gateway_identifier, targetId=target_id
        ),
        ready="READY",
        terminal=("CREATE_FAILED", "UPDATE_FAILED", "DELETING", "FAILED"),
        attempts=TARGET_ATTEMPTS,
        interval=TARGET_INTERVAL,
        label=f"gateway target {target_id}",
        status_key=lambda r: r["status"],
        detail=lambda r: r.get("statusReasons"),
    )
    return {"status": "READY"}


def start_kb_ingestion(*, knowledge_base_id: str, data_source_id: str, **_: Any) -> dict:
    """Start a KB ingestion job and block until it completes.

    ⚠️ Load-bearing, not tidiness. Creating a KB does not start an ingestion job: S3 objects are
    ingested only by an explicit StartIngestionJob. A managed KB left un-ingested is created EMPTY,
    its connector target still validates and reports READY, tools/list still advertises the filter
    parameters, and every retrieval returns an empty result set with no error anywhere. The whole
    feature reads as "filters work — everything matches nothing".

    ⚠️ The returned document counts are the evidence that the corpus really landed, and they are
    NOT redundant with the status: a job can report COMPLETE with a non-zero failed count, and a
    managed-KB job has been observed dropping 5 documents while reporting 0 failed. If the numbers
    look wrong, go to ListKnowledgeBaseDocuments — a dropped document is simply ABSENT from it.

    :param knowledge_base_id: the knowledge base to ingest into.
    :param data_source_id: the data source to ingest from.
    :returns: {"job_id", "scanned", "indexed", "failed"} as strings.
    :raises RuntimeError: when the job reaches FAILED/STOPPED or does not finish in time.
    """
    client = boto3.client("bedrock-agent")
    job_id = client.start_ingestion_job(
        knowledgeBaseId=knowledge_base_id, dataSourceId=data_source_id
    )["ingestionJob"]["ingestionJobId"]
    print(f"KB ingestion job: {job_id}")

    final = _poll(
        describe=lambda: client.get_ingestion_job(
            knowledgeBaseId=knowledge_base_id,
            dataSourceId=data_source_id,
            ingestionJobId=job_id,
        ),
        ready="COMPLETE",
        terminal=("FAILED", "STOPPED"),
        attempts=INGESTION_ATTEMPTS,
        interval=INGESTION_INTERVAL,
        label=f"ingestion job {job_id}",
        status_key=lambda r: r["ingestionJob"]["status"],
        detail=lambda r: r["ingestionJob"].get("failureReasons"),
    )
    stats = final["ingestionJob"].get("statistics", {})
    counts = {
        "job_id": job_id,
        "scanned": str(stats.get("numberOfDocumentsScanned", "")),
        "indexed": str(stats.get("numberOfNewDocumentsIndexed", "")),
        "failed": str(stats.get("numberOfDocumentsFailed", "")),
    }
    print(f"  ingestion counts: {counts}")
    return counts


def push_editable_seeds(*, bucket: str, seeds: dict[str, dict], **_: Any) -> dict:
    """Reconcile the UI-editable S3 seed objects against the repo content.

    ⚠️ The seed CONTENT arrives in the invocation input because a Lambda has no repo checkout. That
    also makes the invocation's input change whenever a seed changes, which is what re-runs this —
    the retired provisioner used a `filemd5` trigger for the same purpose.

    The decision table lives in seed_push, shared with the operator-facing
    infra/scripts/push_editable_seeds.py so the two callers cannot disagree about when a live edit
    wins and when a conflict needs a human.

    :param bucket: the assets bucket.
    :param seeds: {key: {"content": ..., "source": ...}}.
    :returns: {key: <what happened>} for every seed.
    :raises seed_push.SeedPushError: when any key needs a human; nothing is written in that case.
    """
    results = seed_push.reconcile(s3=boto3.client("s3"), bucket=bucket, seeds=seeds)
    for key, outcome in sorted(results.items()):
        print(f"[seed-push] {outcome}")
    return results


ACTIONS: dict[str, Callable[..., dict]] = {
    "wait_kb_data_source": wait_kb_data_source,
    "wait_gateway_target": wait_gateway_target,
    "start_kb_ingestion": start_kb_ingestion,
    "push_editable_seeds": push_editable_seeds,
}


def handle(event: dict, _context: Any = None) -> dict:
    """Dispatch on ``event["action"]`` and return the action's result.

    Terraform reads the result through ``aws_lambda_invocation.result``, so every value in the
    returned dict must be JSON-serializable. An unknown action raises rather than no-oping: a typo
    in a Terraform `input` would otherwise skip a load-bearing wait and report success.

    :param event: {"action": <name>, ...action-specific arguments}.
    :param _context: Lambda context (unused).
    :returns: the action's result dict.
    :raises ValueError: when ``action`` is missing or unrecognized.
    """
    action = event.get("action")
    if action not in ACTIONS:
        raise ValueError(f"unknown action {action!r}; expected one of {sorted(ACTIONS)}")
    arguments = {k: v for k, v in event.items() if k != "action"}
    print(f"[deploy-actions] {action} {arguments}")
    return ACTIONS[action](**arguments)

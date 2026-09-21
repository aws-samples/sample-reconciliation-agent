"""Fail-soft retrieval of consolidated records from an AgentCore Memory namespace.

Both apps recall advisory context from AgentCore Memory before a model call: recon's analyst
lessons (:mod:`backend.recon_core.lessons_recall`) and the deal pipeline's edge-case parsing
rules (:mod:`backend.deal_pipeline.memory_recall`). The API call, the query limit and the failure
policy are the same for both; only the namespace convention and the return shape differ, and
those stay with the callers.

Imports nothing beyond the standard library at module load (boto3 is created lazily), so the
module is safe for a Lambda zip that vendors no third-party wheels.
"""

import logging

logger = logging.getLogger(__name__)

# ``retrieve_memory_records`` rejects a ``searchQuery`` longer than this.
SEARCH_QUERY_MAX_CHARS = 1000


def retrieve_records(
    memory_id: str, namespace: str, query: str, *, top_k: int, client=None
) -> list[dict]:
    """Return the most relevant consolidated records in a namespace as ``{record_id, text}`` dicts.

    Fail-soft by design: recalled memories are advisory, so ANY failure (throttle, a namespace
    with no records yet, a missing endpoint, a client that cannot be built) returns [] with a
    WARNING rather than failing the caller's run. Records with no text are dropped.

    :param memory_id: AgentCore Memory id. "" disables recall: no client is built, no call is made.
    :param namespace: full namespace, e.g. ``reconciliation/lessons/cash``.
    :param query: semantic search text; truncated to the API's 1000-character limit.
    :param top_k: maximum number of records.
    :param client: boto3 ``bedrock-agentcore`` data-plane client (injected in tests); created
        lazily when None.
    :returns: ``[{"record_id": str, "text": str}, ...]``, possibly empty.
    """
    if not memory_id:
        return []
    try:
        if client is None:
            import boto3

            client = boto3.client("bedrock-agentcore")
        resp = client.retrieve_memory_records(
            memoryId=memory_id,
            namespace=namespace,
            searchCriteria={"searchQuery": query[:SEARCH_QUERY_MAX_CHARS], "topK": top_k},
        )
        hits = []
        for record in resp.get("memoryRecordSummaries", []):
            text = (record.get("content") or {}).get("text", "")
            if text:
                hits.append({"record_id": record.get("memoryRecordId", ""), "text": text})
        return hits
    except Exception as exc:  # noqa: BLE001 - advisory context, never fail the caller's run
        logger.warning(
            "memory recall failed (memory %s, namespace %s): %s", memory_id, namespace, exc
        )
        return []

"""Recall analyst lessons from AgentCore Memory for the agent's classify/investigate context.

The BFF writes each analyst decision as a memory event; the `lessons_learned` SEMANTIC
strategy extracts and consolidates them into records under ``reconciliation/lessons/<domain>``.
Before classifying an item, the agent retrieves the most relevant lessons and includes them as
advisory context — so prior corrections on similar items inform future proposals.
"""

import logging

logger = logging.getLogger(__name__)


def retrieve_lessons(
    *,
    memory_id: str,
    domain: str,
    query: str,
    client=None,
    top_k: int = 5,
) -> list[str]:
    """Return the text of the most relevant consolidated lessons for a domain.

    Fail-soft by design: lessons are advisory context, so ANY failure (missing memory id,
    throttle, empty store) returns [] rather than breaking the reconciliation run.

    :param memory_id: AgentCore Memory id (empty string disables recall).
    :param domain: recon domain — the actorId segment of the lessons namespace.
    :param query: semantic search query (e.g. a compact item summary).
    :param client: boto3 ``bedrock-agentcore`` data-plane client (injected in tests).
    :param top_k: max lessons to return.
    :returns: list of lesson texts, possibly empty.
    """
    if not memory_id:
        return []
    try:
        if client is None:
            import boto3

            client = boto3.client("bedrock-agentcore")
        resp = client.retrieve_memory_records(
            memoryId=memory_id,
            namespace=f"reconciliation/lessons/{domain}",
            searchCriteria={"searchQuery": query[:1000], "topK": top_k},
        )
        return [
            r.get("content", {}).get("text", "")
            for r in resp.get("memoryRecordSummaries", [])
            if r.get("content", {}).get("text")
        ]
    except Exception as exc:  # noqa: BLE001 - advisory context, never fail the run
        logger.warning("lessons recall failed (memory %s, domain %s): %s", memory_id, domain, exc)
        return []

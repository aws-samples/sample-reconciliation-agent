"""Recall analyst lessons from AgentCore Memory for the agent's classify/investigate context.

The BFF writes each analyst decision as a memory event; the `lessons_learned` SEMANTIC
strategy extracts and consolidates them into records under ``reconciliation/lessons/<domain>``.
Before classifying an item, the agent retrieves the most relevant lessons and includes them as
advisory context — so prior corrections on similar items inform future proposals.
"""

from backend.recon_core.memory import retrieve_records


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
    hits = retrieve_records(
        memory_id, f"reconciliation/lessons/{domain}", query, top_k=top_k, client=client
    )
    return [hit["text"] for hit in hits]

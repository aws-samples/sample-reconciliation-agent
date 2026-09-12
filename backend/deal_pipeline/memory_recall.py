"""Recall edge-case parsing rules from AgentCore Memory before the parsing agent's first model call.

The assistant's ``save_memory`` tool and the Memory Manager write rules as events; the knowledge
memory's ``edge_cases`` strategy consolidates them into records under
``deal-pipeline/edge-cases/<actorId>``. The parser retrieves the records most relevant to the
email (query = subject + the first 600 characters of the body) and injects them as advisory
context, so a situational correction ("project-finance TLBs are First Lien in the OMS") applies
to the next matching email without a skill edit.
"""

from backend.recon_core.memory import retrieve_records


def retrieve_rules(
    memory_id: str,
    namespace: str,
    query: str,
    top_k: int = 6,
    client=None,
) -> list[dict]:
    """Return the most relevant consolidated edge-case rules for a namespace.

    Fail-soft by design: memories are advisory, so ANY failure (empty memory id, throttle, a
    namespace with no records yet, a missing endpoint) returns [] rather than failing the parse.
    The record id is returned alongside the text so the UI can link a hit back to the Memory
    Manager and the assistant can delete a rule that misfired.

    :param memory_id: AgentCore Memory id ("" disables recall).
    :param namespace: full namespace, e.g. ``deal-pipeline/edge-cases/deal-desk``.
    :param query: semantic search text; truncated to the API's 1000-character limit.
    :param top_k: maximum number of records.
    :param client: boto3 ``bedrock-agentcore`` data-plane client (injected in tests).
    :returns: ``[{"record_id": str, "text": str}, ...]``, possibly empty.
    """
    if not memory_id or not query.strip():
        return []
    return retrieve_records(memory_id, namespace, query, top_k=top_k, client=client)

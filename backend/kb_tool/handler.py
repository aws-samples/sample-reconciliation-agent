"""Knowledge-base search tool: Gateway Lambda target wrapping Bedrock KB Retrieve.

Exposes the platform's fully managed Bedrock Knowledge Base (reconciliation guidance,
S3-sourced) as the ``knowledge-base`` tool on the AgentCore Gateway.
"""

import os

import boto3


def handle(event, _context, *, client=None):
    """Retrieve the most relevant guidance passages for a query.

    Event (tool input): {"query": str, "top_k"?: int}. Returns
    {"results": [{"text", "score", "source"}]}.

    :param client: injectable bedrock-agent-runtime client (tests).
    :raises ValueError: when no query is provided (fail loudly).
    """
    query = (event.get("query") or "").strip()
    if not query:
        raise ValueError("query is required")
    top_k = max(1, min(int(event.get("top_k") or 5), 10))
    client = client or boto3.client("bedrock-agent-runtime")
    resp = client.retrieve(
        knowledgeBaseId=os.environ["KB_ID"],
        retrievalQuery={"text": query[:1000]},
        retrievalConfiguration={"vectorSearchConfiguration": {"numberOfResults": top_k}},
    )
    results = [
        {
            "text": r.get("content", {}).get("text", ""),
            "score": r.get("score"),
            "source": r.get("location", {}).get("s3Location", {}).get("uri", ""),
        }
        for r in resp.get("retrievalResults", [])
    ]
    return {"results": results, "count": len(results)}

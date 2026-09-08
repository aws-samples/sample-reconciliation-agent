#!/usr/bin/env python3
"""Invoke one tool on the AgentCore Gateway (`tools/call`) and show what comes back.

`tools/list` (see mcp_tools_list.py) proves a `parameterOverrides` entry reached the tool's
inputSchema. It does NOT prove the parameter does anything: the connector can accept a filter,
apply it, and return an empty result set with HTTP 200 for either of two opposite reasons -- the
filter matched nothing, or the filter was ignored and the query matched nothing. Only a real call
with a known-good filter and a known-bad filter, compared, tells you which.

This is also the only way to answer the questions a managed knowledge base does not document:

* does `retrievalResults[].metadata` carry the `.metadata.json` sidecar attributes at all? (If not,
  agent-driven metadata filtering is inert and there is nothing to build on top of it.)
* what does SMART_PARSING actually extract from a .pdf / .xlsx / .html? A binary that parsed to
  garbage indexes exactly like one that parsed cleanly; the extracted text is the only tell.

Usage:
    # sanity: unfiltered retrieval
    python3 scripts/mcp_tool_call.py --gateway-url https://<id>.gateway.bedrock-agentcore.\
us-east-1.amazonaws.com --query 'value date mismatch'

    # does the sidecar metadata come back?
    python3 scripts/mcp_tool_call.py --query 'value date mismatch' --metadata-only

    # does a filter actually filter? Run both and compare the source URIs.
    python3 scripts/mcp_tool_call.py --query 'settlement' \
        --filter '{"listContains": {"key": "break_class", "value": "timing"}}'
    python3 scripts/mcp_tool_call.py --query 'settlement' \
        --filter '{"equals": {"key": "doc_type", "value": "no_such_type"}}'   # expect 0 results

⚠️ The argument shape is NESTED, mirroring the Bedrock Retrieve API rather than flattening the
overridden leaves into top-level argument names. That is not a choice this script makes; it is what
the generated inputSchema requires, and getting it wrong is a JSON-RPC error rather than a silent
miss. See build_arguments().
"""

from __future__ import annotations

import argparse
import json
import sys

# Sibling module: sys.path[0] is scripts/ when this is run as `python3 scripts/mcp_tool_call.py`.
from mcp_tools_list import mcp_request, resolve_gateway_url

DEFAULT_TOOL = "managed-kb___Retrieve"


def build_arguments(
    *,
    query: str,
    filter_json: str | None,
    number_of_results: int | None,
) -> dict:
    """Assemble the nested argument object `managed-kb___Retrieve` expects.

    The three `ParameterOverrides` paths ($.retrievalQuery.text,
    $.retrievalConfiguration.managedSearchConfiguration.numberOfResults and .filter) surface as a
    NESTED schema, not as three flat arguments. `retrievalQuery` is the only required member, and
    `retrievalConfiguration` must be omitted entirely rather than sent empty when there is nothing
    to put in it.

    Args:
        query: Natural-language retrieval query.
        filter_json: A Bedrock RetrievalFilter as a JSON string, or None for no filter.
        number_of_results: How many passages to return, or None to leave the admin default (5).

    Returns:
        The arguments object to pass as `tools/call` params.arguments.

    Raises:
        ValueError: If filter_json is not a JSON object. A malformed filter would otherwise be
            rejected by the gateway with a message that does not name this as the cause.
    """
    managed_search: dict = {}
    if filter_json is not None:
        parsed = json.loads(filter_json)
        if not isinstance(parsed, dict):
            raise ValueError(f"--filter must be a JSON object, got {type(parsed).__name__}")
        managed_search["filter"] = parsed
    if number_of_results is not None:
        managed_search["numberOfResults"] = number_of_results

    arguments: dict = {"retrievalQuery": {"text": query}}
    if managed_search:
        arguments["retrievalConfiguration"] = {"managedSearchConfiguration": managed_search}
    return arguments


def extract_payload(*, result: dict) -> dict | list | str:
    """Pull the tool's own payload out of the MCP `tools/call` envelope.

    MCP wraps a tool result in `content: [{type, text}]`, and the connector puts the Retrieve
    response in that text as a JSON string -- so it needs decoding twice. `isError` is reported by
    the tool, NOT as a JSON-RPC error, so a failed retrieval arrives looking like a success.

    Args:
        result: The JSON-RPC `result` object from a tools/call response.

    Returns:
        The decoded tool payload, or the raw text when it is not JSON.

    Raises:
        RuntimeError: If the tool reported isError, or the envelope has no content.
    """
    content = result.get("content")
    if not content:
        raise RuntimeError(f"tools/call result has no content member: {json.dumps(result)[:2000]}")

    texts = [block.get("text", "") for block in content if block.get("type") == "text"]
    joined = "\n".join(texts)

    if result.get("isError"):
        raise RuntimeError(f"tool reported isError: {joined[:2000]}")

    try:
        return json.loads(joined)
    except json.JSONDecodeError:
        return joined


def summarise(*, payload: dict | list | str, metadata_only: bool) -> None:
    """Print a retrieval payload in the form the open questions actually need.

    The full response is dominated by chunk text, which buries the two things under test: which
    documents came back, and what metadata each carries. This prints one block per result with the
    source URI, the score, the metadata keys and the first line of extracted text.

    Args:
        payload: Decoded tool payload.
        metadata_only: When True, print each result's metadata in full and omit the text.
    """
    if not isinstance(payload, dict) or "retrievalResults" not in payload:
        # Not a Retrieve response (another tool, or an unexpected shape) -- show it verbatim rather
        # than guessing at its structure.
        print(json.dumps(payload, indent=2, sort_keys=True) if not isinstance(payload, str) else payload)
        return

    results = payload["retrievalResults"]
    print(f"retrievalResults: {len(results)}")
    for index, entry in enumerate(results):
        location = entry.get("location", {})
        uri = location.get("s3Location", {}).get("uri") or json.dumps(location)
        metadata = entry.get("metadata") or {}
        print(f"\n[{index}] score={entry.get('score')}  {uri}")
        if metadata_only:
            print(f"    metadata: {json.dumps(metadata, indent=6, sort_keys=True)}")
            continue
        print(f"    metadata keys: {sorted(metadata)}")
        text = (entry.get("content") or {}).get("text", "")
        first_line = next((line for line in text.splitlines() if line.strip()), "")
        print(f"    text[0:200]: {first_line[:200]!r}")

    if not results:
        # The single most misleading outcome in this whole feature, so it gets said out loud.
        print(
            "\n⚠️ ZERO results. This is what BOTH a working filter that matched nothing AND a "
            "silently ignored filter look like. Re-run without --filter to tell them apart.",
            file=sys.stderr,
        )


def main() -> int:
    """Call one gateway tool and summarise the response.

    Returns:
        Process exit code: 0 on success, 1 if the call failed or the tool reported an error.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway-url", default=None, help="Gateway URL; default: read from Terraform.")
    parser.add_argument("--terraform-dir", default="infra/environments/recon")
    parser.add_argument("--region", default="us-east-1")
    parser.add_argument("--profile", default="huthmac")
    parser.add_argument("--tool", default=DEFAULT_TOOL)
    parser.add_argument("--query", required=True, help="Natural-language retrieval query.")
    parser.add_argument("--filter", default=None, help="Bedrock RetrievalFilter as a JSON string.")
    parser.add_argument("--number-of-results", type=int, default=None)
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="Print each result's metadata in full instead of its text.",
    )
    parser.add_argument("--raw", action="store_true", help="Print the whole payload verbatim.")
    args = parser.parse_args()

    gateway_url = args.gateway_url or resolve_gateway_url(terraform_dir=args.terraform_dir)
    arguments = build_arguments(
        query=args.query,
        filter_json=args.filter,
        number_of_results=args.number_of_results,
    )
    print(f"tools/call {args.tool} arguments={json.dumps(arguments)}", file=sys.stderr)

    try:
        result = mcp_request(
            gateway_url=gateway_url,
            method="tools/call",
            params={"name": args.tool, "arguments": arguments},
            region=args.region,
            profile=args.profile,
        )
        payload = extract_payload(result=result)
    except RuntimeError as error:
        print(str(error), file=sys.stderr)
        return 1

    if args.raw:
        print(json.dumps(payload, indent=2, sort_keys=True) if not isinstance(payload, str) else payload)
        return 0

    summarise(payload=payload, metadata_only=args.metadata_only)
    return 0


if __name__ == "__main__":
    sys.exit(main())

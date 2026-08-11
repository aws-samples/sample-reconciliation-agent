"""Build the first InvokeHarness user message for one reconciliation item.

The system prompt (the tool-calling workflow contract) is supplied separately from live S3; this
module assembles the per-item first message: the item JSON, the IDP class + confidence, the
recalled analyst lessons (authoritative), and a compact workflow reminder.
"""

import json

from backend.recon_core.schema import ReconItem


def build_first_message(*, item: ReconItem, lessons: list[str] | None = None) -> dict:
    """Return a Converse-shape user message ``{role, content:[{text}]}`` for the item.

    :param item: the reconciliation item to investigate.
    :param lessons: recalled analyst lessons (advisory-authoritative), or None.
    :returns: a single user message dict for ``messages=[...]``.
    """
    idp_class = item.attributes.get("idp_class") or "unknown"
    idp_conf = item.attributes.get("idp_classification_confidence")
    lessons_block = (
        "\n".join(f"- {lesson}" for lesson in lessons)
        if lessons
        else "(no prior analyst lessons for this domain)"
    )
    text = (
        "Reconcile the following item. Follow the workflow contract in your system prompt: "
        "classify by the IDP document class, load the matching skill, investigate via the "
        "gateway tools BY THEIR FULL PREFIXED NAMES (general-ledger___search_ledger / "
        "knowledge-base___search_guidance / document-extraction___IDPTools___get_results — "
        "short names fail with Unknown tool), then call "
        "submit_proposal EXACTLY ONCE. Calling submit_proposal is MANDATORY — never end with a "
        "text answer before it. submit_proposal REQUIRES class_name, classification_reasoning, "
        "resolution, and verbalized_confidence — always include resolution (the human-readable "
        "fix for the break); it is distinct from the optional reason note and is never omitted. "
        "Do not include a ledger reference in submit_proposal — it is "
        "derived from your search_ledger results. The platform performs any ledger write and "
        "notification itself; the submit_proposal tool result reports the decision and "
        "outcome — only then reply with one short closing summary and stop.\n\n"
        f"IDP document class: {idp_class}\n"
        f"IDP classification confidence: {idp_conf if idp_conf is not None else 'n/a'}\n\n"
        "Prior analyst lessons (authoritative — prefer these over your own judgment):\n"
        f"{lessons_block}\n\n"
        "Item:\n"
        f"{json.dumps(item.model_dump(), default=str, indent=2)}"
    )
    return {"role": "user", "content": [{"text": text}]}

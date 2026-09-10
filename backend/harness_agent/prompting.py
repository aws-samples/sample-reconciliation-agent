"""Build the first InvokeHarness user message for one reconciliation item.

The system prompt (the tool-calling workflow contract) is supplied separately from live S3; this
module assembles the per-item first message: the item JSON, the IDP class + confidence, the
recalled analyst lessons (authoritative), and a compact workflow reminder.
"""

import json

from backend.recon_core.schema import ReconItem
from backend.recon_core.skill_meta import evidence_step_block
from backend.recon_core.tier1_hint import read_hint


def _evidence_steps_block(catalog: list[dict]) -> str:
    """Render every catalog entry's declared evidence-step ids, grouped by skill name.

    The harness has no skill-loading tool (see ``harness_config.ALLOWED_TOOLS``), so unlike the
    runtime backend it never gets a skill body — yet its system prompt asks it to report one entry per
    step "the skill lists in its ``evidence_steps`` front matter". Without this block it cannot see
    those ids and invents plausible ones instead (``ledger_lookup``, ``amount_tolerance_check``),
    every one of which is unscoreable. All entries are rendered, not just Tier-1's hinted one,
    because the harness classifies for itself and must be able to report against whichever class it
    picks.

    :param catalog: the live SKILL.md catalog.
    :returns: the prompt block (newline-terminated), or '' when no entry declares any step.
    """
    blocks = [
        f"### {entry.get('name')}{block}"
        for entry in catalog
        if (block := evidence_step_block(entry))
    ]
    if not blocks:
        return ""
    return (
        "\nEvidence steps by classification type. Report `evidence_steps` for the type you choose, "
        "using ONLY that type's ids below, verbatim — an id that is not listed for your chosen type "
        "is discarded and the step it was meant to report counts as never attempted:\n"
        + "\n".join(blocks)
        + "\n"
    )


def _class_hint_line(*, attributes: dict, catalog: list[dict]) -> str:
    """Format Tier-1's break classification as one advisory line ('' when there is none).

    Mirrors ``strands_investigator._class_hint_block`` on the runtime backend, deliberately: the two
    Tier-2 backends must present Tier-1's class the same way, or identical items get classified
    differently depending on which one served them. A HINT, never a directive — Tier-1's rules
    (``backend/tier1/classify.py``) see only the item's shape, not its evidence.

    Dropped unless it names a catalog entry. The value comes off a stored DynamoDB item that an older
    deploy, a manual submission or the Cases UI produced, so it is untrusted text heading for a
    prompt, and a class with no skill behind it is useless to the agent anyway.

    :param attributes: the item's attribute bag (reads ``tier1_break_type``).
    :param catalog: the live SKILL.md catalog — the validation set for the hint.
    :returns: the prompt line (newline-terminated), or '' when there is no usable hint.
    """
    break_type = read_hint(attributes=attributes)
    if not break_type or break_type not in {c["name"] for c in catalog}:
        return ""
    return (
        f"Tier-1 deterministic classification (a hint — your own classification governs): "
        f"{break_type}\n"
    )


def build_first_message(
    *, item: ReconItem, catalog: list[dict], lessons: list[str] | None = None
) -> dict:
    """Return a Converse-shape user message ``{role, content:[{text}]}`` for the item.

    :param item: the reconciliation item to investigate.
    :param catalog: the live SKILL.md catalog, used to validate Tier-1's class hint.
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
        "notices___search_notices / managed-kb___Retrieve — "
        "short names fail with Unknown tool), then call "
        "submit_proposal EXACTLY ONCE. Calling submit_proposal is MANDATORY — never end with a "
        "text answer before it. submit_proposal REQUIRES class_name, classification_reasoning and "
        "resolution — always include resolution (the human-readable fix for the break); it is "
        "distinct from the optional reason note and is never omitted. "
        "Do not include a ledger reference in submit_proposal — it is "
        "derived from your search_ledger results. The platform performs any ledger write and "
        "notification itself; the submit_proposal tool result reports the decision and "
        "outcome — only then reply with one short closing summary and stop.\n\n"
        f"IDP document class: {idp_class}\n"
        f"IDP classification confidence: {idp_conf if idp_conf is not None else 'n/a'}\n"
        f"{_class_hint_line(attributes=item.attributes or {}, catalog=catalog)}\n"
        f"{_evidence_steps_block(catalog)}\n"
        "Prior analyst lessons (authoritative — prefer these over your own judgment):\n"
        f"{lessons_block}\n\n"
        "Item:\n"
        f"{json.dumps(item.model_dump(), default=str, indent=2)}"
    )
    return {"role": "user", "content": [{"text": text}]}

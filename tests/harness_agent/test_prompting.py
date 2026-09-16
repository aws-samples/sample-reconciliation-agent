"""Tests for the harness first-message prompt."""

from backend.harness_agent import prompting
from backend.recon_core.schema import ReconItem

_CATALOG = [{"name": "record-match-review"}, {"name": "unknown"}]


def _item(**attributes) -> ReconItem:
    """Build a sides-less item carrying the given attribute bag.

    :param attributes: item attributes to set.
    :returns: the item.
    """
    return ReconItem(item_id="i-1", domain="cash", sides=[], attributes=attributes)


def test_the_tier1_class_is_offered_as_a_hint():
    """Both Tier-2 backends must present Tier-1's class the same way — as advice, not an order.

    The runtime path does this in ``strands_investigator._class_hint_block``. A divergence here
    would only show up as the two backends disagreeing on classification for identical items.
    """
    msg = prompting.build_first_message(
        item=_item(tier1_break_type="record-match-review"), catalog=_CATALOG
    )
    text = msg["content"][0]["text"]
    assert "record-match-review" in text and "hint" in text.lower()


def test_no_hint_line_when_tier1_did_not_classify():
    text = prompting.build_first_message(item=_item(), catalog=_CATALOG)["content"][0]["text"]
    assert "Tier-1" not in text


def test_a_class_outside_the_catalog_is_dropped():
    """`tier1_break_type` is untrusted stored text; only a real catalog entry reaches the prompt."""
    text = prompting.build_first_message(
        item=_item(tier1_break_type="deleted-skill"), catalog=_CATALOG
    )["content"][0]["text"]
    assert "Tier-1" not in text and "deleted-skill" not in text.split("Item:")[0]


# --- the declared evidence-step ids: the harness's ONLY source for them ---

_CATALOG_WITH_STEPS = [
    {
        "name": "record-match-review",
        "evidence_steps": [
            {"id": "expected_entry_match", "required": True, "description": "Find the GL entry."},
            {"id": "fund_alias_match", "required": False, "description": "Resolve the alias."},
        ],
    },
    {"name": "unknown"},
]


def test_the_prompt_names_every_declared_step_id():
    """The harness has NO skill-loading tool, so this block is the only place the ids exist.

    Without it the model invents plausible ids from the skill's prose — a live run produced
    ``ledger_lookup`` and ``amount_tolerance_check``. Every invented id is unscoreable, so each
    prescribed step it stood for counts as never attempted and the case scores 0.
    """
    text = prompting.build_first_message(item=_item(), catalog=_CATALOG_WITH_STEPS)["content"][0][
        "text"
    ]
    assert "expected_entry_match" in text
    assert "fund_alias_match" in text


def test_every_class_is_rendered_not_just_the_tier1_hint():
    """The harness classifies for itself, so it must see the ids of whichever class it picks."""
    catalog = _CATALOG_WITH_STEPS + [
        {"name": "timing-difference", "evidence_steps": [{"id": "value_date_check", "required": True, "description": "d"}]}
    ]
    text = prompting.build_first_message(
        item=_item(tier1_break_type="record-match-review"), catalog=catalog
    )["content"][0]["text"]
    assert "value_date_check" in text


def test_a_catalog_declaring_no_steps_renders_no_block():
    text = prompting.build_first_message(item=_item(), catalog=_CATALOG)["content"][0]["text"]
    assert "Evidence steps by classification type" not in text


def test_the_prompt_asks_for_no_self_reported_confidence():
    """The model is asked for the evidence it obtained per prescribed step, never for a number
    about itself. Asking for one is how it came to be gated on: the field was mandatory, the parse
    rejected a proposal that omitted it, and a low value rewrote a good class to 'unknown'.
    """
    text = prompting.build_first_message(item=_item(), catalog=_CATALOG)["content"][0]["text"]
    assert "classification_confidence" not in text
    assert "verbalized_confidence" not in text
    # The IDP per-field EXTRACTION confidence is a different quantity — a document-quality hint that
    # nothing gates on — and stays on the prompt.
    assert "IDP classification confidence" in text

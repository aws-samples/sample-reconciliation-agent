"""Tests that all classification-type SKILL.md files are present and valid."""

import json
import re
from pathlib import Path

import pytest
from skills_loader import catalog

from backend.recon_core.email_policy import DRAFT_PENDING, build_persisted_draft

SKILLS_DIR = Path(__file__).parent.parent.parent / "agent-blueprint/recon-agent/skills"


def test_all_skill_types_present_and_valid():
    entries = {e["name"]: e for e in catalog(SKILLS_DIR)}
    assert set(entries) == {
        "record-match-review",
        "document-cross-reference",
        "correspondence-search",
        "counterparty-contact-draft",
        "consult-guidance",
        "ledger-status-resolution",
        "unknown",
    }
    for name, e in entries.items():
        assert e["description"], f"{name} missing description"
        assert isinstance(e["tools"], list)  # tools frontmatter (may be empty for `unknown`)
        assert "model" in e  # optional per-skill model override (None when unset)


def test_every_skill_declares_a_known_tier():
    """The taxonomy must be explicit, because `tier` is what tells a reader whether a skill is a
    classification the agent picks or a procedure it invokes along the way."""
    for e in catalog(SKILLS_DIR):
        assert isinstance(e["metadata"], dict), f"{e['name']} metadata must be a mapping"
        tier = e["metadata"].get("tier")
        assert tier in {"break-type", "probe", "resolution", "fallback"}, f"{e['name']}: {tier}"


def test_every_tier1_class_exists_in_the_catalog():
    """The one build-time check behind Tier-1's rule table.

    ``BREAK_TYPE_RULES`` names classes as bare strings; nothing at runtime resolves them, because
    the stream consumer deliberately cannot read the catalog. Rename or delete a skill and Tier-1 goes
    on stamping a `tier1_break_type` that both Tier-2 backends silently drop as unknown
    (``_class_hint_block`` / ``_class_hint_line``) — a hint that vanishes with no error anywhere. This
    test is the only thing that turns that into a failure.
    """
    from backend.tier1.classify import BREAK_TYPE_RULES

    shipped = {e["name"] for e in catalog(SKILLS_DIR)}
    assert BREAK_TYPE_RULES, "an empty rule table would make this whole check vacuous"
    for name, _predicate in BREAK_TYPE_RULES:
        assert name in shipped, f"Tier-1 rule names {name!r}, which is not a shipped skill"


# --- the counterparty-draft skill's prescribed JSON vs. the email policy ----------------------


class _TemplateDeclaring:
    """A TemplateStore stand-in whose declared variables are whatever the skill's example supplies.

    The template is the operator's, so a test cannot know its real names. What it CAN pin is that the
    skill's example satisfies the template it says it satisfies: this stand-in declares exactly the
    keys the skill put in ``variables``, which is the contract the skill states in prose ("a value for
    exactly the names in that template's `variables` list").
    """

    def __init__(self, *, declared: list[str]) -> None:
        """Serve one template declaring ``declared``.

        :param declared: the variable names the template requires.
        """
        self._declared = declared

    def get(self, *, template_id: str) -> dict:
        """Return a template whose subject and body reference every declared variable.

        :param template_id: the id the draft cited; echoed back, not matched.
        :returns: a template row in TemplateStore shape.
        """
        placeholders = " ".join(f"{{{{{name}}}}}" for name in self._declared)
        return {
            "template_id": template_id,
            "subject_template": f"Query {placeholders}",
            "body_template": f"Please confirm {placeholders}.",
            "variables": self._declared,
        }


def _skill_email_draft() -> dict:
    """Extract the ``email_draft`` block the counterparty-draft skill tells the model to emit.

    Parsed out of the shipped markdown rather than restated here on purpose. A copy in this file could
    stay green while the skill drifted, which is the exact failure this test exists to catch: the skill
    once prescribed ``{recipient_hint, subject, body}``, a shape ``build_persisted_draft`` rejects and
    both call sites then discard, so a model following it produced nothing and nobody was told.

    :returns: the ``email_draft`` sub-object from the skill's first ```json fenced block.
    :raises AssertionError: when the skill has no such block, or it does not carry ``email_draft``.
    """
    text = (SKILLS_DIR / "counterparty-contact-draft.md").read_text(encoding="utf-8")
    blocks = re.findall(r"```json\n(.*?)```", text, flags=re.DOTALL)
    assert blocks, "counterparty-contact-draft.md prescribes no JSON block at all"
    payload = json.loads(blocks[0])
    assert "email_draft" in payload, "the skill's example must be keyed under `email_draft`"
    return payload["email_draft"]


def test_the_skill_prescribes_a_draft_the_email_policy_accepts():
    """The shape the skill documents must be the shape the backend persists, field for field."""
    example = _skill_email_draft()
    draft = build_persisted_draft(
        email_draft=example,
        templates=_TemplateDeclaring(declared=sorted(example["variables"])),
    )
    assert draft["draft_status"] == DRAFT_PENDING
    assert draft["render_error"] is None
    # The two ids the policy requires survive into the persisted row.
    assert draft["recipient_contact_id"] == example["recipient_contact_id"]
    assert draft["template_id"] == example["template_id"]
    # No address is stored, and the skill's hint is a name that reached the row for cross-checking.
    assert draft["recipient"] is None
    assert draft["recipient_hint"] == example["recipient_hint"]


@pytest.mark.parametrize("forbidden", ["recipient", "subject", "body"])
def test_the_skill_never_prescribes_an_address_or_message_text(forbidden):
    """``recipient`` is refused with a ValueError; ``subject``/``body`` are ignored because the
    operator's template owns the wording. A skill offering any of the three teaches the model to
    produce a field the backend will not read."""
    assert forbidden not in _skill_email_draft()

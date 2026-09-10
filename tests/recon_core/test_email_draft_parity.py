"""Both agent backends must persist the SAME ``proposed_email`` for the same ``email_draft``.

The two backends build the draft in different places — the Strands runtime inside
``strands_investigator._investigate``, the harness inside ``intake.build_proposal`` — and only the
helper they share (``recon_core.email_policy.build_persisted_draft``) keeps the shapes identical. A
drift would not fail anything here: it would surface much later as a gateway-interceptor denial at
send time, on whichever backend happened to run that item, and read as "the approval button is
broken". So the parity is asserted directly, backend against backend, rather than each backend
against a hardcoded expectation (which both could satisfy while disagreeing with each other).

Each side runs through its own ``build_proposal`` rather than the helper, so the pass-through onto
``Proposal.proposed_email`` is covered too — dropping that keyword argument is the silent failure
mode the plan called out, and it is invisible to a helper-level test.
"""

import json

import pytest
from proposal import build_proposal as runtime_build_proposal
from strands_investigator import make_strands_investigator

from backend.harness_agent import intake
from backend.harness_agent.stream import StreamResult
from backend.recon_core import email_policy
from backend.recon_core.email_policy import build_persisted_draft
from backend.recon_core.schema import ClassificationResult, ReconItem

ITEM = ReconItem(
    item_id="idp-1",
    domain="loan-servicing",
    sides=[{"name": "ledger", "attributes": {"reference": "DDTL-A-0001"}}],
    attributes={"idp_class": "LoanDrawCancellationNotice"},
)
CLASSIFICATION = ClassificationResult(
    class_id="document-cross-reference", reasoning="draw cancellation notice"
)
CATALOG = [
    {"name": "document-cross-reference", "confidence_threshold": 0.7},
    {"name": "unknown", "confidence_threshold": 0.0},
]
DRAFT = {
    "recipient_contact_id": "cp-cindermoor",
    "recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.",
    "template_id": "tpl-wire-reference",
    "variables": {"wire_date": "2026-08-03"},
}
TEMPLATE = {
    "template_id": "tpl-wire-reference",
    "subject_template": "Wire reference confirmation",
    "body_template": "Please confirm the reference on the {{wire_date}} wire.",
    "variables": ["wire_date"],
}


class _Templates:
    """A TemplateStore stand-in serving the one template both backends render."""

    def get(self, *, template_id: str) -> dict:
        """Return ``TEMPLATE`` regardless of the id asked for.

        :param template_id: the id the draft cited; recorded but not matched, because the parity this
            file asserts is about the two backends agreeing, not about template lookup.
        :returns: ``TEMPLATE``.
        """
        return TEMPLATE


@pytest.fixture(autouse=True)
def _stub_template_store(monkeypatch) -> None:
    """Point ``build_persisted_draft`` at the stand-in store for every test in this module.

    Neither backend passes a ``templates`` argument — they call the helper the same way production
    does, which is the whole point of driving them end to end here. So the seam has to be the module
    function they both reach, not a keyword either could forget.

    :param monkeypatch: pytest's patching fixture.
    :returns: None.
    """
    monkeypatch.setattr(email_policy, "_template_store", lambda: _Templates())


def _runtime_proposed_email(email_draft) -> dict | None:
    """Persisted draft the RUNTIME backend produces for ``email_draft``.

    Drives the real agentic loop with a fake agent whose final message carries ``email_draft``, so
    the draft travels the production path: model output → ``_parse_proposal`` → ``_investigate`` →
    ``proposal.build_proposal`` → ``Proposal``.

    :param email_draft: the model's ``email_draft`` block, or None to omit it entirely.
    :returns: the ``proposed_email`` map on the assembled Proposal (None when there is none).
    """

    def tool_caller(name: str, args: dict) -> dict:
        return {"rows": [{"reference": "DDTL-A-0001"}]} if name == "search_ledger" else {}

    def agent_factory(model_id, system_prompt, tools):
        class _Result:
            def __init__(self, text: str) -> None:
                self.message = {"role": "assistant", "content": [{"text": text}]}

        class _Agent:
            def __call__(self, prompt: str) -> "_Result":
                final = {
                    "resolution": "Ask the counterparty to confirm the reference.",
                    "confidence": 0.8,
                    "evidence": ["reference: DDTL-A-0001"],
                    "status": "Cancelled",
                    "reason": "awaiting counterparty confirmation",
                }
                if email_draft is not None:
                    final["email_draft"] = email_draft
                return _Result(json.dumps(final))

        return _Agent()

    prop = runtime_build_proposal(
        item=ITEM,
        classification=CLASSIFICATION,
        fake_investigate=make_strands_investigator(
            model_id="m",
            system="sys",
            tool_caller=tool_caller,
            agent_factory=agent_factory,
        ),
        skills=[{"name": "document-cross-reference", "body": "Confirm against the ledger."}],
    )
    return prop.proposed_email


def _harness_proposed_email(email_draft) -> dict | None:
    """Persisted draft the HARNESS backend produces for the same ``email_draft``.

    :param email_draft: the ``email_draft`` field of the ``submit_proposal`` input, or None to omit.
    :returns: the ``proposed_email`` map on the assembled Proposal (None when there is none).
    """
    submitted = {
        "class_name": "document-cross-reference",
        "classification_reasoning": "draw cancellation notice",
        "resolution": "Ask the counterparty to confirm the reference.",
        "status": "Cancelled",
        "reason": "awaiting counterparty confirmation",
        "evidence": ["reference: DDTL-A-0001"],
    }
    if email_draft is not None:
        submitted["email_draft"] = email_draft
    stream = StreamResult()
    stream.tool_outputs["search_ledger"] = [{"rows": [{"reference": "DDTL-A-0001"}]}]
    prop = intake.build_proposal(
        item=ITEM,
        submitted=submitted,
        stream_result=stream,
        catalog=CATALOG,
    )
    return prop.proposed_email


def test_both_backends_persist_an_identical_draft():
    runtime = _runtime_proposed_email(DRAFT)
    harness = _harness_proposed_email(DRAFT)
    assert runtime == harness
    # Pin the shape too: equal-but-both-empty would satisfy the comparison above.
    assert runtime == build_persisted_draft(email_draft=DRAFT)
    assert runtime["draft_status"] == "pending" and runtime["revision"] == 0
    # Both rendered the operator's template, and neither stored an address.
    assert runtime["subject"] == "Wire reference confirmation"
    assert runtime["body"] == "Please confirm the reference on the 2026-08-03 wire."
    assert runtime["recipient"] is None and runtime["recipient_contact_id"] == "cp-cindermoor"


def test_neither_backend_invents_a_draft_when_the_model_omits_one():
    """Most items need no counterparty email — an empty draft on every case would train the analyst
    to click through the approval panel without reading it."""
    assert _runtime_proposed_email(None) is None
    assert _harness_proposed_email(None) is None


def test_neither_backend_keeps_a_model_supplied_address():
    """The injection path this feature closes: the item text comes from a document an outside party
    wrote, so an address in it is attacker-influenceable. The operator supplies the recipient list.

    The helper refuses a literal address rather than stripping it, so both backends drop the draft
    entirely — and the address cannot reach the case row by any route.
    """
    poisoned = {**DRAFT, "recipient": "attacker@evil.example"}
    assert _runtime_proposed_email(poisoned) is None
    assert _harness_proposed_email(poisoned) is None


def test_a_draft_citing_no_template_is_rejected_by_the_shared_helper():
    """The helper is where the requirement lives, so both backends inherit it — and neither can
    quietly accept half a draft, which would leave the UI offering approval for text that is not
    there."""
    with pytest.raises(ValueError, match="missing required field"):
        build_persisted_draft(email_draft={"recipient_contact_id": "cp-cindermoor"})


def test_both_backends_drop_an_incomplete_draft_instead_of_failing_the_item():
    """Parity extends to the failure direction: neither backend may raise. Both fail toward human
    review — the resolution still lands and the item still escalates, just without a draft."""
    incomplete = {"recipient_hint": "CINDERMOOR LOGISTICS HOLDINGS INC.", "template_id": "   "}
    assert _runtime_proposed_email(incomplete) is None
    assert _harness_proposed_email(incomplete) is None


def test_both_backends_persist_an_identical_render_failure():
    """A render failure must not be a place the two backends diverge.

    It is persisted rather than raised, so unlike the cases above it produces a ROW — and a row is
    exactly what can differ between backends while both look fine in isolation.
    """
    undeclared = {**DRAFT, "variables": {"wire_date": "2026-08-03", "amount": "100"}}
    runtime = _runtime_proposed_email(undeclared)
    harness = _harness_proposed_email(undeclared)
    assert runtime == harness
    assert runtime["draft_status"] == "render_failed"
    assert "amount" in runtime["render_error"]


def test_both_backends_recover_a_draft_the_model_emitted_as_a_json_string():
    """THE parity break this file exists to catch.

    The harness model can emit the nested ``email_draft`` object as a JSON STRING; an
    ``isinstance(_, dict)`` guard then drops it, so the harness produces no draft at all while the
    runtime produces one for the identical item — the exact backend-against-backend divergence
    described at the top of this module, and one no hardcoded per-backend expectation would catch.
    ``email_draft`` is the first nested-object property in the harness's argument schema, which the
    harness does not enforce.
    """
    stringified = json.dumps(DRAFT)
    runtime = _runtime_proposed_email(stringified)
    harness = _harness_proposed_email(stringified)
    assert runtime == harness
    # Identical to the draft persisted when the model emits a real object — not merely non-None.
    assert harness == build_persisted_draft(email_draft=DRAFT)


def test_neither_backend_coerces_prose_into_a_draft():
    """The decode stays narrow. A model writing a sentence where an object belongs has not produced
    a message a human should be asked to approve, so both backends must still drop it."""
    assert _runtime_proposed_email("email the borrower about the wire") is None
    assert _harness_proposed_email("email the borrower about the wire") is None
    # Object-framed but truncated mid-string: unparseable, so dropped rather than half-recovered.
    assert _harness_proposed_email('{"subject": "Wire", "body": "Please conf') is None

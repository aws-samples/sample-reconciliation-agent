"""One case per row of the verdict table, plus the traps the table cannot express.

Three of the rows carry the weight here, because each is a shape that an ungated write sails straight
through:

* more than one distinct notice — derives a None notice id, which reads as nothing to doubt;
* a playbook cited as evidence — indistinguishable from citing nothing unless the axis names it;
* correspondence cited while the route is disabled.
"""

from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.evidence_quality import (
    CLEAN,
    DOUBTFUL,
    UNVERIFIABLE,
    decide_evidence_quality,
    kb_evidence_enabled,
)


def _notice(**overrides: object) -> dict:
    """Build a notice row as ``search_notices`` returns it.

    :param overrides: attributes to replace or remove (pass ``None`` for a NULL alert count).
    :returns: the row.
    """
    row: dict = {"notice_id": "NTC-1", "confidence_alert_count": 0}
    row.update(overrides)
    return row


def _kb(doc_type: str | None) -> dict:
    """Build a knowledge-base retrieval result.

    :param doc_type: the ``doc_type`` metadata value, or None to omit it entirely.
    :returns: the retrieval result.
    """
    metadata = {} if doc_type is None else {"doc_type": doc_type}
    return {"content": {"text": "..."}, "metadata": metadata}


def _decide(notices=(), kb=(), enabled=False) -> tuple[str, str]:
    """Call the decision with defaults that keep each test to its one variable.

    :param notices: notice rows.
    :param kb: knowledge-base results.
    :param enabled: whether the KB route is enabled as an evidence source.
    :returns: ``(verdict, reason)``.
    """
    return decide_evidence_quality(
        notices=list(notices), kb_documents=list(kb), kb_evidence_enabled=enabled
    )


# --- notices ---------------------------------------------------------------------------------------


def test_one_notice_with_no_alerts_is_clean() -> None:
    """The passing case, unchanged from the guard this replaces."""
    verdict, reason = _decide(notices=[_notice()])
    assert verdict == CLEAN
    assert "NTC-1" in reason


def test_a_zero_alert_count_is_not_treated_as_absent() -> None:
    """`0` is the clean case AND is falsy, so a truthiness test inverts the commonest outcome.

    Asserted separately from the test above because the two would fail together only if the
    implementation were right; a truthiness bug makes this one fail while the happy path still reads
    plausibly.
    """
    assert _decide(notices=[_notice(confidence_alert_count=Decimal("0"))])[0] == CLEAN


def test_a_positive_alert_count_is_doubtful() -> None:
    """The extraction flagged fields: evaluated, and not trustworthy."""
    verdict, reason = _decide(notices=[_notice(confidence_alert_count=Decimal("3"))])
    assert verdict == DOUBTFUL
    assert "3 extracted field(s)" in reason


def test_a_null_alert_count_is_unverifiable_not_doubtful() -> None:
    """ "We could not read the extraction" is a different finding from "the extraction is bad".

    The mapper propagates None deliberately for this case, and an operator's next action differs: one
    means look at the document, the other means look at the pipeline.
    """
    verdict, reason = _decide(notices=[_notice(confidence_alert_count=None)])
    assert verdict == UNVERIFIABLE
    assert "unresolved" in reason


def test_a_notice_missing_the_attribute_entirely_is_unverifiable() -> None:
    """Every extracted notice carries the attribute, so its absence means this row is not one of those.

    Treating absence as zero is what would deactivate the guard for precisely the rows that never went
    through the pipeline it checks.
    """
    row = _notice()
    del row["confidence_alert_count"]
    verdict, reason = _decide(notices=[row])
    assert verdict == UNVERIFIABLE
    assert "records no confidence_alert_count" in reason


def test_more_than_one_distinct_notice_is_unverifiable() -> None:
    """⚠️ The shape most likely to slip through ungated.

    `derive_notice_id` returns None when a search matched several notices, and an absent id reads as
    "nothing to be doubtful about" unless this axis refuses it. `record-match-review` declares
    `cardinality: ranked_set`, so a multi-candidate result is the normal case rather than an edge one.
    """
    verdict, reason = _decide(notices=[_notice(), _notice(notice_id="NTC-2")])
    assert verdict == UNVERIFIABLE
    assert "2 distinct notices" in reason
    assert "NTC-1" in reason and "NTC-2" in reason


def test_the_same_notice_cited_twice_is_not_ambiguous() -> None:
    """Two rows for one notice is a duplicate in the tool output, not two candidates.

    Distinctness is what matters; counting rows instead would refuse a perfectly resolved single match
    because the agent happened to call the tool twice.
    """
    assert _decide(notices=[_notice(), _notice()])[0] == CLEAN


def test_a_non_numeric_alert_count_raises() -> None:
    """A shape this platform wrote and must therefore never see; guessing at it would hide a real bug."""
    with pytest.raises(TypeError, match="confidence_alert_count"):
        _decide(notices=[_notice(confidence_alert_count="three")])


def test_a_boolean_alert_count_raises() -> None:
    """`bool` is a subclass of `int`, so True would otherwise compare as a count of one."""
    with pytest.raises(TypeError):
        _decide(notices=[_notice(confidence_alert_count=True)])


# --- no notice: what else was cited decides ---------------------------------------------------------


def test_nothing_cited_at_all_is_clean() -> None:
    """Ledger-only reasoning on a manual item with no document behind it — a legitimate case."""
    verdict, reason = _decide()
    assert verdict == CLEAN
    assert "ledger alone" in reason


def test_consulting_a_playbook_does_not_affect_the_verdict() -> None:
    """⚠️ The tempting rule that must NOT be written here, and why.

    Refusing any proposal that touched guidance without matching a notice sounds strict but refuses
    nearly every legitimate ledger-only resolution, because EVERY investigation consults method — that
    is what guidance is for. Retrieving a playbook says nothing about what a conclusion rests on, so it
    is not on this axis at all: it can never make a verdict clean, and it never makes one worse.
    """
    verdict, reason = _decide(kb=[_kb("playbook")])
    assert verdict == CLEAN
    assert "rests on the ledger alone" in reason


def test_a_playbook_can_never_make_a_verdict_clean_on_its_own_merit() -> None:
    """The other half of the same property: the toggle governs CORRESPONDENCE, never method.

    Enabling the knowledge-base route must not turn a playbook into evidence. The verdict here is clean
    because of the LEDGER, and the reason has to say so — if it ever cites the playbook, the toggle has
    been wired to the wrong axis.
    """
    verdict, reason = _decide(kb=[_kb("playbook")], enabled=True)
    assert verdict == CLEAN
    assert "playbook" not in reason and "correspondence" not in reason


def test_correspondence_is_clean_when_the_route_is_enabled() -> None:
    """A counterparty's own statement, and an operator has decided it counts."""
    verdict, reason = _decide(kb=[_kb("email")], enabled=True)
    assert verdict == CLEAN
    assert "archived counterparty correspondence" in reason


def test_an_email_attachment_is_citable_too() -> None:
    """The schedule that arrived with a message is the same kind of evidence as the message."""
    assert _decide(kb=[_kb("email_attachment")], enabled=True)[0] == CLEAN


def test_correspondence_is_unverifiable_when_the_route_is_disabled() -> None:
    """⚠️ NEW. Refuse rather than infer consent from the document merely being in the corpus.

    The reason has to name the toggle: an operator who reads "unverifiable" has no next action, and one
    who reads "enable it in Config" has exactly one.
    """
    verdict, reason = _decide(kb=[_kb("email")], enabled=False)
    assert verdict == UNVERIFIABLE
    assert "Config" in reason


def test_a_document_with_no_doc_type_is_not_treated_as_evidence() -> None:
    """An unidentifiable document cannot be actual-side evidence, so it cannot make a verdict clean.

    It also does not refuse: the proposal still rests on its ledger reference. The property being pinned
    is that only a POSITIVELY identified email or attachment can put a verdict on the correspondence
    path — never a document whose kind is merely unknown.
    """
    verdict, reason = _decide(kb=[_kb(None)], enabled=True)
    assert verdict == CLEAN
    assert "rests on the ledger alone" in reason


def test_a_playbook_beside_correspondence_does_not_poison_it() -> None:
    """Consulting guidance while also citing a counterparty's letter is normal, correct behaviour."""
    assert _decide(kb=[_kb("playbook"), _kb("email")], enabled=True)[0] == CLEAN


# --- notices and knowledge-base content together ----------------------------------------------------


def test_a_clean_notice_plus_knowledge_base_documents_is_clean() -> None:
    """The notice is what makes it clean; the citations alongside are weighed at zero."""
    assert _decide(notices=[_notice()], kb=[_kb("playbook"), _kb("email")])[0] == CLEAN


def test_knowledge_base_documents_cannot_rescue_a_doubtful_notice() -> None:
    """⚠️ The back door this closes: guidance must never add weight to a verdict.

    A doubtful extraction stays doubtful however much corroborating material is cited beside it. If this
    ever returns CLEAN, a playbook has become load-bearing.
    """
    verdict, _ = _decide(
        notices=[_notice(confidence_alert_count=Decimal("5"))],
        kb=[_kb("email"), _kb("playbook")],
        enabled=True,
    )
    assert verdict == DOUBTFUL


def test_knowledge_base_documents_cannot_rescue_an_unverifiable_notice() -> None:
    """Same property on the other failing verdict: a cited notice we cannot judge is not rescued."""
    assert (
        _decide(notices=[_notice(confidence_alert_count=None)], kb=[_kb("email")], enabled=True)[0]
        == UNVERIFIABLE
    )


# --- every verdict carries an actionable reason ------------------------------------------------------


@pytest.mark.parametrize(
    "kwargs",
    [
        {"notices": [_notice()]},
        {"notices": [_notice(confidence_alert_count=Decimal("2"))]},
        {"notices": [_notice(confidence_alert_count=None)]},
        {"notices": [_notice(), _notice(notice_id="NTC-9")]},
        {},
        {"kb": [_kb("playbook")]},
        {"kb": [_kb(None)]},
        {"kb": [_kb("email")], "enabled": True},
        {"kb": [_kb("email")], "enabled": False},
    ],
)
def test_every_outcome_explains_itself(kwargs) -> None:
    """The reason is quoted in the gateway's denial and shown on the case, so it may never be empty.

    :param kwargs: one input combination per verdict path.
    """
    verdict, reason = _decide(**kwargs)
    assert verdict in {CLEAN, DOUBTFUL, UNVERIFIABLE}
    assert reason and len(reason) > 20, f"{verdict} came back with an unhelpful reason: {reason!r}"


# --- resolving the Config toggle ---------------------------------------------------------------------


def _workflow_types(rows: list[dict]) -> str:
    """Create the workflow-types table and write the given rows.

    :param rows: items to write.
    :returns: the table name.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    table = ddb.create_table(
        TableName="recon-workflow-types",
        KeySchema=[{"AttributeName": "workflow_type_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "workflow_type_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    for row in rows:
        table.put_item(Item=row)
    return "recon-workflow-types"


@mock_aws
def test_an_active_knowledge_base_workflow_type_enables_evidence() -> None:
    """The seeded `counterparty-guidance` row is exactly this shape."""
    name = _workflow_types([{"workflow_type_id": "kb", "route": "knowledge-base", "active": True}])
    assert kb_evidence_enabled(table_name=name) is True


@mock_aws
def test_an_inactive_knowledge_base_workflow_type_does_not() -> None:
    """Deactivating the row in Config is how an operator withdraws correspondence as evidence."""
    name = _workflow_types([{"workflow_type_id": "kb", "route": "knowledge-base", "active": False}])
    assert kb_evidence_enabled(table_name=name) is False


@mock_aws
def test_an_active_extraction_route_does_not_enable_kb_evidence() -> None:
    """The toggle is per-ROUTE. An active extraction workflow says nothing about the knowledge base."""
    name = _workflow_types([{"workflow_type_id": "idp", "route": "extraction", "active": True}])
    assert kb_evidence_enabled(table_name=name) is False


@mock_aws
def test_no_workflow_types_at_all_means_not_enabled() -> None:
    """An empty table is a coherent answer: nobody has enabled anything."""
    assert kb_evidence_enabled(table_name=_workflow_types([])) is False


def test_a_read_failure_raises_rather_than_defaulting_to_false() -> None:
    """False is a POLICY statement; an unreachable table is not one.

    Defaulting to False would refuse every correspondence-grounded write during a transient DynamoDB
    problem, and the refusal would tell the operator to check a Config setting that is already correct.
    """

    class _Broken:
        def Table(self, _name):
            raise RuntimeError("throttled")

    with pytest.raises(RuntimeError, match="could not read workflow types"):
        kb_evidence_enabled(table_name="recon-workflow-types", ddb=_Broken())

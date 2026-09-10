"""The shared token-usage mapper, and the case record's ``token_usage`` field.

Two things are asserted here. First the mapper (``recon_core.token_usage.summarize_token_usage``):
it is deliberately the ONLY producer of this shape, because both Tier-2 backends persist the field
from separate deployment units and a second implementation is how they come to disagree about what a
count means. Second the stored field: it round-trips through a real (moto) write/read, an already-
stored case that predates it still validates, and a float count — the one type boto3's DynamoDB
resource refuses — fails the write loudly instead of being rounded into the record.
"""

from decimal import Decimal

import boto3
import pytest
from moto import mock_aws

from backend.recon_core.cases import CaseStore
from backend.recon_core.schema import Proposal, ReconItem
from backend.recon_core.status import CaseStatus
from backend.recon_core.token_usage import summarize_token_usage

MODEL = "us.anthropic.claude-sonnet-5"


# --- the mapper -----------------------------------------------------------------------------------


def test_counts_sum_across_every_turn() -> None:
    """Several turns' reports add up; the result is not the last turn's numbers.

    This is the whole reason the mapper takes a LIST: both backends are multi-turn, so a mapper that
    accepted one dict would push the accumulation into two call sites that could drift apart.

    :returns: None.
    """
    usage = summarize_token_usage(
        usages=[
            {"inputTokens": 1200, "outputTokens": 300},
            {"inputTokens": 1800, "outputTokens": 120},
            {"inputTokens": 40, "outputTokens": 7},
        ],
        model_id=MODEL,
        backend="harness",
    )
    assert usage == {
        "input_tokens": Decimal("3040"),
        "output_tokens": Decimal("427"),
        "model_id": MODEL,
        "backend": "harness",
    }


def test_every_count_is_a_decimal_and_never_a_float() -> None:
    """boto3's DynamoDB resource raises TypeError on a Python float — see the write test below.

    A float would therefore fail at runtime on every real case while every dict-level assertion in
    this file still passed, so the type is asserted directly rather than the value alone.

    :returns: None.
    """
    usage = summarize_token_usage(
        # A JSON number can decode as a float; the mapper must not pass one through.
        usages=[{"inputTokens": 10.0, "outputTokens": 2, "cacheReadInputTokens": 5}],
        model_id=MODEL,
        backend="runtime",
    )
    counts = {k: v for k, v in usage.items() if k.endswith("_tokens")}
    assert counts and all(isinstance(v, Decimal) for v in counts.values())
    assert not any(isinstance(v, float) for v in counts.values())


def test_nothing_measured_is_none_and_not_a_set_of_zeros() -> None:
    """An empty list and a list of empty dicts both mean "nobody measured this run".

    Zeros would read on the case screen as a free run, which is a different (and false) claim.

    :returns: None.
    """
    assert summarize_token_usage(usages=[], model_id=MODEL, backend="harness") is None
    assert summarize_token_usage(usages=[{}, {}], model_id=MODEL, backend="harness") is None


def test_cache_keys_absent_everywhere_stay_absent() -> None:
    """A count no turn reported must not be invented as 0.

    "This provider reported no cache figures" and "the cache was read zero times" are different
    facts, and the UI has to be able to tell them apart.

    :returns: None.
    """
    usage = summarize_token_usage(
        usages=[{"inputTokens": 5, "outputTokens": 1}], model_id=MODEL, backend="harness"
    )
    assert "cache_read_tokens" not in usage
    assert "cache_write_tokens" not in usage


def test_cache_keys_present_on_some_turns_sum_over_those_turns() -> None:
    """A mixed run: only the turns that reported cache figures contribute to them.

    The absent key on the other turns is not a zero to be added, and it does not suppress the key
    that WAS reported either.

    :returns: None.
    """
    usage = summarize_token_usage(
        usages=[
            {"inputTokens": 100, "outputTokens": 10, "cacheReadInputTokens": 900},
            {"inputTokens": 200, "outputTokens": 20},  # no cache keys at all on this turn
            {
                "inputTokens": 300,
                "outputTokens": 30,
                "cacheReadInputTokens": 100,
                "cacheWriteInputTokens": 40,
            },
        ],
        model_id=MODEL,
        backend="harness",
    )
    assert usage["input_tokens"] == Decimal("600")
    assert usage["output_tokens"] == Decimal("60")
    assert usage["cache_read_tokens"] == Decimal("1000")
    # Reported by exactly one turn — present, and equal to that turn's figure only.
    assert usage["cache_write_tokens"] == Decimal("40")


def test_an_explicit_null_count_is_treated_as_absent() -> None:
    """A null on the wire is an unreported figure, not a zero one.

    :returns: None.
    """
    usage = summarize_token_usage(
        usages=[{"inputTokens": 5, "outputTokens": 1, "cacheReadInputTokens": None}],
        model_id=MODEL,
        backend="harness",
    )
    assert "cache_read_tokens" not in usage


def test_unknown_provider_keys_are_ignored() -> None:
    """``totalTokens`` is derivable from the parts, so it is not stored beside them.

    A stored total that could disagree with its own components is worse than no total.

    :returns: None.
    """
    usage = summarize_token_usage(
        usages=[{"inputTokens": 5, "outputTokens": 1, "totalTokens": 6}],
        model_id=MODEL,
        backend="harness",
    )
    assert set(usage) == {"input_tokens", "output_tokens", "model_id", "backend"}


def test_a_blank_model_id_raises_rather_than_storing_unlabelled_usage() -> None:
    """The cost is derived from the model id later, so an unlabelled record is a mispriced one.

    :returns: None.
    """
    with pytest.raises(ValueError, match="model id"):
        summarize_token_usage(usages=[{"inputTokens": 1}], model_id="  ", backend="harness")


def test_an_unknown_backend_raises() -> None:
    """The two backends measure differently, so the label has to be one of the two real ones.

    :returns: None.
    """
    with pytest.raises(ValueError, match="backend must be one of"):
        summarize_token_usage(usages=[{"inputTokens": 1}], model_id=MODEL, backend="lambda")


def test_a_non_numeric_count_raises_instead_of_scoring_zero() -> None:
    """A count that is not a number is a change in the stream's contract, not a free run.

    :returns: None.
    """
    with pytest.raises(ValueError, match="inputTokens"):
        summarize_token_usage(usages=[{"inputTokens": "lots"}], model_id=MODEL, backend="harness")


# --- the stored field ----------------------------------------------------------------------------


def test_a_stored_case_without_token_usage_still_validates() -> None:
    """Every case already in DynamoDB predates this field; none may become unreadable on read.

    Same convention as ``ReasoningStep``'s optional fields — cases are long-lived records, so a
    required new field breaks the case-detail read on history rather than merely leaving it unmeasured.

    :returns: None.
    """
    prop = Proposal(
        item_id="idp-old",
        class_id="document-cross-reference",
        classification_reasoning="x",
        resolution="Mark cancelled.",
    )
    assert prop.token_usage is None
    # And the same via a raw stored payload, which is how the case row actually comes back.
    assert Proposal.model_validate(prop.model_dump(exclude={"token_usage"})).token_usage is None


def _make_tables() -> None:
    """Create the cases + audit tables in moto (no GSI needed for these assertions).

    :returns: None.
    """
    ddb = boto3.resource("dynamodb", region_name="us-east-1")
    ddb.create_table(
        TableName="recon-cases",
        KeySchema=[{"AttributeName": "item_id", "KeyType": "HASH"}],
        AttributeDefinitions=[{"AttributeName": "item_id", "AttributeType": "S"}],
        BillingMode="PAY_PER_REQUEST",
    )
    ddb.create_table(
        TableName="recon-audit",
        KeySchema=[
            {"AttributeName": "item_id", "KeyType": "HASH"},
            {"AttributeName": "ts", "KeyType": "RANGE"},
        ],
        AttributeDefinitions=[
            {"AttributeName": "item_id", "AttributeType": "S"},
            {"AttributeName": "ts", "AttributeType": "S"},
        ],
        BillingMode="PAY_PER_REQUEST",
    )


def _open_case(cases: CaseStore) -> None:
    """Open an IN_PROGRESS case so ``attach_proposal``'s existence guard is satisfied.

    :param cases: the store bound to the moto tables.
    :returns: None.
    """
    cases.open(
        ReconItem(item_id="idp-1", domain="loan-servicing", sides=[]),
        status=CaseStatus.IN_PROGRESS,
        tier=2,
    )


@mock_aws
def test_token_usage_round_trips_through_a_real_write_and_read() -> None:
    """The mapper's output survives DynamoDB unchanged — counts, model id and backend label.

    :returns: None.
    """
    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    _open_case(cases)
    usage = summarize_token_usage(
        usages=[{"inputTokens": 1000, "outputTokens": 200, "cacheReadInputTokens": 3000}],
        model_id=MODEL,
        backend="harness",
    )

    cases.attach_proposal(
        item_id="idp-1",
        class_id="document-cross-reference",
        classification_reasoning="x",
        resolution="Mark cancelled.",
        confidence=Decimal("1"),
        steps=[],
        notice_search=None,
        token_usage=usage,
    )

    stored = cases.get("idp-1")["token_usage"]
    assert stored == {
        "input_tokens": Decimal("1000"),
        "output_tokens": Decimal("200"),
        "cache_read_tokens": Decimal("3000"),
        "model_id": MODEL,
        "backend": "harness",
    }
    # Absence survives the round trip too: the key is not resurrected as a zero by the store.
    assert "cache_write_tokens" not in stored


@mock_aws
def test_a_float_count_fails_the_write_instead_of_being_rounded_in() -> None:
    """The positive control behind the Decimal rule: boto3 refuses a float outright.

    This is why the mapper coerces and why ``attach_proposal`` does NOT re-coerce — a caller that
    bypassed the mapper has to fail here, loudly, rather than have its numbers quietly adjusted.

    :returns: None.
    """
    _make_tables()
    cases = CaseStore(table="recon-cases", audit="recon-audit")
    _open_case(cases)
    with pytest.raises(TypeError, match="[Ff]loat"):
        cases.attach_proposal(
            item_id="idp-1",
            class_id="document-cross-reference",
            classification_reasoning="x",
            resolution="Mark cancelled.",
            confidence=Decimal("1"),
            steps=[],
            notice_search=None,
            token_usage={"input_tokens": 1.5, "model_id": MODEL, "backend": "harness"},
        )


def test_attach_proposal_requires_the_token_usage_keyword() -> None:
    """A caller that omits it must fail at binding time, not write NULL.

    The second caller of ``attach_proposal`` lives outside ``backend/``
    (``agent-blueprint/recon-agent/agent.py``), which is how ``notice_search`` shipped to one backend
    and left the other writing NULL for a day. There is no default here for the same omission to hide
    behind.

    :returns: None.
    """
    store = CaseStore.__new__(CaseStore)  # no AWS: the TypeError is raised at binding time
    with pytest.raises(TypeError, match="token_usage"):
        store.attach_proposal(
            item_id="idp-1",
            class_id="unknown",
            classification_reasoning="ambiguous",
            resolution="Escalate.",
            confidence=0,
            steps=[],
            notice_search=None,
        )

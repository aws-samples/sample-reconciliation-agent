"""Metadata-filter construction for the managed-KB ``Retrieve`` tool.

⚠️ Why this file is unusually assertive about SHAPE rather than behaviour.

The worst mistake this module can make is UNOBSERVABLE at runtime: Bedrock accepts the filter,
matches nothing, and returns ``{"retrievalResults": []}`` with HTTP 200. Nothing raises, no log line
appears, and the agent reads the empty list as "there is no guidance for this break" and improvises
a resolution. The three traps, with what each actually does -- all verified live 2026-08-27 against
``managed-kb___Retrieve``, because the difference decides how much this file has to carry:

* a ``STRING_LIST`` attribute (``break_class``, ``skill``) filtered with ``equals`` -- **SILENT**.
  Zero results, HTTP 200, no error. It also excludes the two cross-cutting playbooks that carry all
  five classes, i.e. it hides the escalation policy precisely when it applies. This is the trap that
  justifies the whole file;
* a ``NUMBER`` attribute (``effective_date``) filtered with a JSON string -- **LOUD**:
  ``DependencyFailedException``, "The filter value type provided isn't supported for the given
  operation". Still worth asserting on, because a raised exception mid-investigation is a degraded
  outcome even when it is visible;
* a single clause wrapped in a one-element ``andAll`` -- **LOUD**, the API requires >=2 members.

So the assertions here are on the constructed filter object: for the first trap that is the only
place the error is observable at all, and for the other two it is where the error is cheapest to
catch.
"""

import json
from pathlib import Path

import pytest

from strands_investigator import (
    GUIDANCE_BREAK_CLASSES,
    GUIDANCE_DOC_TYPES,
    MAX_GUIDANCE_RESULTS,
    build_guidance_filter,
    build_retrieve_arguments,
)

CORPUS = Path(__file__).resolve().parents[2] / "data" / "kb-seed"


def _managed_search(arguments: dict) -> dict:
    """Dig the managedSearchConfiguration out of a built argument object ({} when absent).

    :param arguments: the object returned by :func:`build_retrieve_arguments`.
    :returns: the managedSearchConfiguration, or {} when the caller set no facets and no top_k.
    """
    return arguments.get("retrievalConfiguration", {}).get("managedSearchConfiguration", {})


# --------------------------------------------------------------------------------------
# build_guidance_filter
# --------------------------------------------------------------------------------------


def test_no_facets_produces_no_filter() -> None:
    """No facets means no filter at all -- NOT an empty filter object.

    An empty ``{}`` is not a valid RetrievalFilter (it carries no operator member), so returning one
    would turn every unfiltered search into a validation error.
    """
    assert build_guidance_filter() is None


def test_a_single_facet_is_returned_bare() -> None:
    """One clause must NOT be wrapped in andAll -- the API requires andAll to hold at least two."""
    assert build_guidance_filter(doc_type="playbook") == {
        "equals": {"key": "doc_type", "value": "playbook"}
    }


def test_two_facets_combine_with_and_all() -> None:
    """Two clauses wrap in andAll, in declaration order."""
    assert build_guidance_filter(doc_type="email", message_id="MSG-1") == {
        "andAll": [
            {"equals": {"key": "doc_type", "value": "email"}},
            {"equals": {"key": "message_id", "value": "MSG-1"}},
        ]
    }


def test_break_class_uses_list_contains_never_equals() -> None:
    """``break_class`` is a STRING_LIST. This is the B2 regression guard.

    ``equals`` against a list attribute matches nothing and returns HTTP 200, so the agent sees "no
    guidance for a timing break". Worse, if it ever did match it would match only the single-class
    playbooks and EXCLUDE source-selection.md and autonomy-and-escalation.md, which carry all five
    classes -- so the escalation policy would vanish from exactly the searches that need it.
    """
    assert build_guidance_filter(break_class="timing") == {
        "listContains": {"key": "break_class", "value": "timing"}
    }


def test_skill_uses_list_contains_never_equals() -> None:
    """``skill`` is also a STRING_LIST, and fails the same silent way."""
    assert build_guidance_filter(skill="record-match-review") == {
        "listContains": {"key": "skill", "value": "record-match-review"}
    }


def test_since_date_filters_effective_date_with_an_int() -> None:
    """The date bound targets ``effective_date``, and its value must be an int, not a string.

    Two separate traps in one clause: filtering the wrong attribute (``received_date`` exists too,
    but only on the email documents, so using it would silently drop every playbook), and passing
    ``"20260701"`` -- a NUMBER attribute compared against a JSON string matches nothing.
    """
    clause = build_guidance_filter(since_date=20260701)
    assert clause == {"greaterThanOrEquals": {"key": "effective_date", "value": 20260701}}
    assert isinstance(clause["greaterThanOrEquals"]["value"], int)


def test_since_date_accepts_a_numeric_string_from_the_model() -> None:
    """Strands does not enforce the ``int`` annotation, so a model may send "20260701"."""
    clause = build_guidance_filter(since_date="20260701")
    assert clause["greaterThanOrEquals"]["value"] == 20260701
    assert isinstance(clause["greaterThanOrEquals"]["value"], int)


def test_since_date_zero_adds_no_clause() -> None:
    """0 is the documented "no bound" value and must not become a 1970 lower bound."""
    assert build_guidance_filter(since_date=0) is None


@pytest.mark.parametrize("bad", [2026, 20261301, 20260732, -20260701, "not-a-date"])
def test_a_malformed_since_date_raises(bad) -> None:
    """Every malformed form still compares numerically, so each one looks like a working filter.

    A 4-digit year silently admits the whole corpus; a month-13 or day-32 value silently excludes
    the rest of that year. Hence a real calendar-date check rather than a range check.

    :param bad: a since_date value that is not an 8-digit YYYYMMDD calendar date.
    """
    with pytest.raises(ValueError, match="since_date"):
        build_guidance_filter(since_date=bad)


def test_all_five_facets_produce_five_clauses() -> None:
    """Every facet contributes exactly one clause, and none is silently dropped."""
    clause = build_guidance_filter(
        doc_type="email_attachment",
        break_class="aggregation",
        skill="document-cross-reference",
        message_id="MSG-20260703-RA88214",
        since_date=20260101,
    )
    assert list(clause) == ["andAll"]
    assert len(clause["andAll"]) == 5
    assert [next(iter(c)) for c in clause["andAll"]] == [
        "equals",
        "listContains",
        "listContains",
        "equals",
        "greaterThanOrEquals",
    ]


@pytest.mark.parametrize("retired", ["patterns", "guidance", "playbooks", "Email"])
def test_a_doc_type_outside_the_vocabulary_raises(retired) -> None:
    """The vocabulary is closed. ``patterns`` is the retired prefix name and the likely mistake.

    Passing it through would filter to empty, which is indistinguishable from an empty corpus. Note
    ``"Email"`` is in here too: the filter is case-SENSITIVE exact-match.

    :param retired: a doc_type value that is not in the corpus.
    """
    with pytest.raises(ValueError, match="doc_type"):
        build_guidance_filter(doc_type=retired)


@pytest.mark.parametrize("bad", ["missing-reference", "timing_difference", "Timing"])
def test_a_break_class_outside_the_vocabulary_raises(bad) -> None:
    """``missing-reference`` (hyphen) is the trap -- the corpus uses ``missing_reference``.

    The hyphenated form is the PLAYBOOK FILENAME, so it is the value a reader of the corpus would
    reach for first, and it matches nothing.

    :param bad: a break_class value that is not in the corpus.
    """
    with pytest.raises(ValueError, match="break_class"):
        build_guidance_filter(break_class=bad)


def test_skill_is_not_validated_against_a_closed_set() -> None:
    """``skill`` deliberately accepts anything: the skill library is editable at runtime.

    The Skills UI writes new SKILL.md files to S3 without a redeploy, so a hard-coded skill
    vocabulary here would reject a legitimately new skill name. The cost is that a typo filters to
    empty -- accepted, because the alternative breaks a supported workflow.
    """
    assert build_guidance_filter(skill="a-skill-invented-yesterday") == {
        "listContains": {"key": "skill", "value": "a-skill-invented-yesterday"}
    }


# --------------------------------------------------------------------------------------
# build_retrieve_arguments -- the NESTED shape the connector target generates
# --------------------------------------------------------------------------------------


def test_arguments_are_nested_not_flat() -> None:
    """The overrides are JSONPaths into the Retrieve request, so the arguments mirror that request.

    A flat ``{"query": ...}`` is rejected by the gateway's schema validation, so the nesting is not
    cosmetic. ``retrievalConfiguration`` is omitted entirely when empty rather than sent as ``{}``.
    """
    assert build_retrieve_arguments(query="value date mismatch") == {
        "retrievalQuery": {"text": "value date mismatch"}
    }


def test_a_filter_lands_under_managed_search_configuration() -> None:
    """The filter's position in the nested object is what the override Path dictates."""
    arguments = build_retrieve_arguments(query="timing", break_class="timing")
    assert arguments["retrievalQuery"] == {"text": "timing"}
    assert _managed_search(arguments) == {
        "filter": {"listContains": {"key": "break_class", "value": "timing"}}
    }


def test_the_query_is_stripped() -> None:
    """Leading/trailing whitespace off a model-generated string is noise, not a query."""
    assert build_retrieve_arguments(query="  timing  ")["retrievalQuery"]["text"] == "timing"


@pytest.mark.parametrize("blank", ["", "   ", "\n"])
def test_a_blank_query_raises(blank) -> None:
    """Bedrock rejects an empty retrievalQuery, but names the API field, not the tool argument.

    :param blank: a query that is empty or whitespace only.
    """
    with pytest.raises(ValueError, match="query"):
        build_retrieve_arguments(query=blank)


def test_top_k_zero_leaves_the_admin_default() -> None:
    """0 must omit numberOfResults so the target's ParameterValues default (5) applies."""
    assert "numberOfResults" not in _managed_search(build_retrieve_arguments(query="x", top_k=0))


def test_top_k_is_passed_through_as_an_int() -> None:
    """A supplied count reaches numberOfResults, as an int."""
    managed_search = _managed_search(build_retrieve_arguments(query="x", top_k=7))
    assert managed_search["numberOfResults"] == 7
    assert isinstance(managed_search["numberOfResults"], int)


def test_top_k_accepts_a_numeric_string_from_the_model() -> None:
    """Same reason as since_date: the ``int`` annotation is not enforced at runtime."""
    assert _managed_search(build_retrieve_arguments(query="x", top_k="7"))["numberOfResults"] == 7


@pytest.mark.parametrize("bad", [MAX_GUIDANCE_RESULTS + 1, 100, -1, "many"])
def test_an_out_of_range_top_k_raises_rather_than_clamping(bad) -> None:
    """A silent clamp hides the mistake; the model never learns its request was not honoured.

    :param bad: a top_k outside 1..MAX_GUIDANCE_RESULTS.
    """
    with pytest.raises(ValueError, match="top_k"):
        build_retrieve_arguments(query="x", top_k=bad)


def test_top_k_and_a_filter_coexist_under_one_managed_search_configuration() -> None:
    """Both overrides target the same parent object, so neither may overwrite the other."""
    managed_search = _managed_search(
        build_retrieve_arguments(query="x", doc_type="playbook", top_k=3)
    )
    assert managed_search == {
        "filter": {"equals": {"key": "doc_type", "value": "playbook"}},
        "numberOfResults": 3,
    }


def test_a_facet_error_propagates_out_of_build_retrieve_arguments() -> None:
    """The validation must not be swallowed on the way through the outer builder."""
    with pytest.raises(ValueError, match="doc_type"):
        build_retrieve_arguments(query="x", doc_type="patterns")


# --------------------------------------------------------------------------------------
# The vocabularies must match the corpus, or the facets filter to empty
# --------------------------------------------------------------------------------------


def _corpus_attribute_values(attribute: str) -> set[str]:
    """Collect every value a sidecar declares for one attribute, across the whole corpus.

    Handles both scalar (``stringValue``) and list (``stringListValue``) attributes so one helper
    covers doc_type and break_class.

    :param attribute: the metadata attribute name.
    :returns: the set of declared values.
    """
    values: set[str] = set()
    for sidecar in sorted(CORPUS.glob("*/*.metadata.json")):
        declared = json.loads(sidecar.read_text())["metadataAttributes"].get(attribute)
        if declared is None:
            continue
        value = declared["value"]
        values.update(value.get("stringListValue", []))
        if "stringValue" in value:
            values.add(value["stringValue"])
    return values


@pytest.mark.parametrize(
    ("attribute", "vocabulary"),
    [("doc_type", GUIDANCE_DOC_TYPES), ("break_class", GUIDANCE_BREAK_CLASSES)],
)
def test_the_closed_vocabularies_match_the_corpus_exactly(attribute, vocabulary) -> None:
    """The wrapper's vocabulary and the corpus must agree in BOTH directions.

    * a corpus value missing from the vocabulary is unreachable -- the wrapper raises on it, so the
      agent can never retrieve that document by that facet;
    * a vocabulary value missing from the corpus is a filter that always returns empty, which reads
      as "no guidance exists".

    Adding a document with a new value therefore fails here rather than degrading retrieval
    silently. Update the constant in strands_investigator.py AND
    infra/modules/recon-agent/kb-connector-target.tf's kb_filter_description (the harness backend
    reads that string instead of this code).

    :param attribute: the sidecar metadata attribute.
    :param vocabulary: the frozenset the wrapper validates against.
    """
    assert _corpus_attribute_values(attribute) == set(vocabulary)

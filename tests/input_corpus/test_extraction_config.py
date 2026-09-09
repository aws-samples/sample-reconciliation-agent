"""The tracked extraction configuration and the contract must agree.

``data/idp-extraction-config/classes.json`` is the class-schema half of the document pipeline's
extraction configuration, tracked here so it can be reviewed and diffed;
``scripts/push_idp_extraction_config.py`` installs it. ``test_extraction_requirements.py`` already
holds the contract and ``backend/idp_hook/mapper.py`` together. This module closes the third side of
the triangle, and it is the side that was open when it mattered:

the deployed configuration had drifted to a completely different vocabulary -- classes named
``LoanPrincipalPaymentNotice``, fields named ``NoticeDate``, ``RecipientShareAmount``,
``Borrower.BorrowerName``, dates in US order -- while the contract, the mapper and this repo's tests
all agreed with each other. Every one of them passed. Extraction found the right values, emitted
them under names nothing read, and the hook reported the notice's own index key as *unavailable*.
Because the configuration lived only in another deployment's DynamoDB table, there was nothing to
diff and nothing to fail.

So these assertions are about NAMES, not about extraction quality. A class whose prose is wrong
extracts badly and shows up in the evaluation sweep; a class whose key is wrong extracts perfectly
and shows up nowhere.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from tests.input_corpus.test_extraction_requirements import (
    _class_rows,
    _first_column,
    _roadmap_keys,
    _section,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CLASSES = REPO_ROOT / "data" / "idp-extraction-config" / "classes.json"
# The corpus's answer key: one result.json per section per sample document, holding the fields a human
# confirmed are readable off that page. Used as a floor on what each class must be able to emit.
GROUND_TRUTH = REPO_ROOT / "data" / "input" / "idp-evaluation" / "ground-truth" / "baseline"

# The push script owns the structural rules (`$id` present, matching `x-aws-idp-document-type`, no
# duplicates, a properties object). Importing it rather than restating them keeps a single definition
# of "well formed" -- and means this test fails if the script's validation is ever weakened.
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from push_idp_extraction_config import load_classes  # noqa: E402

# The fallback class. §1 mandates it in prose rather than in the table ("An unrecognised document must
# still classify -- report `unclassified`") because it has no sample document and no folder, so the
# table has nothing to put in its other columns.
FALLBACK_CLASS = "unclassified"

# Contract keys that are alternatives the platform ACCEPTS, not values extraction should produce. The
# mapper reads `counterparty or borrower`; every class here emits `counterparty`, so nothing needs to
# emit `borrower` and a class that did would be offering the mapper a second, lower-priority answer to
# a question already answered.
FALLBACK_ONLY_KEYS = frozenset({"borrower"})

# `notice_date` and `counterparty` are the notices table's range and hash key: the mapper RAISES when
# neither `notice_date` nor `value_date` is extracted, and stores a missing `counterparty` as the
# literal `unknown`. A class that cannot carry them is a class whose documents cannot be retrieved.
INDEX_KEYS = frozenset({"notice_date", "counterparty"})

# The one class allowed to omit `notice_date`, and why. A truncated fax cover carries a borrower name
# and a letterhead and nothing else -- the corpus ground truth for `Agent Notice - Partial Fax Cover`
# has three fields and no date of any kind. Giving the class a date property would not conjure a date
# onto the page; it would invite the model to infer one, and a confident wrong date on a document
# whose defining property is that it is unreadable is worse than the mapper's raise. So this notice
# class is expected to dead-letter, which the contract states outright (§2's warning).
CLASSES_WITHOUT_NOTICE_DATE = frozenset({"incomplete_notice"})


def _artifact_classes() -> list[dict]:
    """Load the tracked class schemas.

    :returns: the list of class schema objects, in file order.
    """
    return load_classes(path=CLASSES)


def _by_id() -> dict[str, dict]:
    """Index the tracked class schemas by their ``$id``.

    :returns: a mapping of class id to schema.
    """
    return {entry["$id"]: entry for entry in _artifact_classes()}


def test_the_artifact_is_well_formed() -> None:
    """Guard every assertion below against passing vacuously on a parse or shape failure.

    ``load_classes`` raises on a malformed artifact, so reaching the assertion is most of the test.
    """
    classes = _artifact_classes()
    assert len(classes) > 1, "the artifact holds fewer classes than the contract documents"


def test_every_documented_class_is_configured() -> None:
    """A documented class with no schema extracts nothing under that name.

    The document still classifies -- as something else, or as ``unclassified`` -- so the failure is a
    notice with the wrong ``notice_class`` rather than a missing one, and nothing reports it.
    """
    documented = {class_name for class_name, _folder in _class_rows()}
    configured = set(_by_id())
    missing = sorted(documented - configured)
    assert not missing, (
        f"the contract documents classes with no schema in {CLASSES.name}: {missing} -- documents of "
        "that kind will classify as something else and reach the platform mislabelled"
    )


def test_the_fallback_class_is_configured() -> None:
    """§1 requires an unrecognised document to classify rather than fail the extraction."""
    assert FALLBACK_CLASS in _by_id(), (
        f"{CLASSES.name} has no {FALLBACK_CLASS!r} class -- §1 requires an unrecognised document to "
        "classify anyway: 'The platform has a path for an unclassified notice; it has no path for a "
        "missing one.'"
    )


def test_no_undocumented_classes() -> None:
    """A class the contract does not name is a `notice_class` value the platform cannot interpret.

    This is the assertion a blueprint-discovery job breaks: discovery appends whatever it inferred
    from the sample it was given, and the deployed config that motivated this test had accumulated 23
    classes that way -- unrelated ones (payslips, W2s, driving licences) alongside near-duplicate
    loan classes whose names collided (`ActivityMemo` and `Activity_Memo`, `LoanRateNotice` and
    `LoanRateSettingNotice`).
    """
    documented = {class_name for class_name, _folder in _class_rows()} | {FALLBACK_CLASS}
    extra = sorted(set(_by_id()) - documented)
    assert not extra, (
        f"{CLASSES.name} configures classes the contract does not document: {extra} -- either add "
        "them to §1 with a sample document, or they are discovery output that must be removed"
    )


def test_every_configured_field_key_is_documented() -> None:
    """A field key outside the contract is extraction work nothing reads.

    The mapper reads by literal key name, so the value lands nowhere and is reported to the agent as
    ``fields_unavailable`` -- indistinguishable from "this class does not carry that field".
    """
    documented = _first_column(_section("2. Field keys")) | _roadmap_keys()
    offenders: dict[str, list[str]] = {}
    for class_id, schema in _by_id().items():
        undocumented = sorted(set(schema["properties"]) - documented)
        if undocumented:
            offenders[class_id] = undocumented
    assert not offenders, (
        f"{CLASSES.name} extracts keys the contract does not define: {offenders} -- the mapper reads "
        "by literal key name, so these values are extracted and then dropped"
    )


def test_every_required_contract_key_is_configured_somewhere() -> None:
    """A contract key no class carries is a field the platform asks for and never receives."""
    documented = _first_column(_section("2. Field keys")) - _roadmap_keys() - FALLBACK_ONLY_KEYS
    configured: set[str] = set()
    for schema in _by_id().values():
        configured.update(schema["properties"])
    missing = sorted(documented - configured)
    assert not missing, (
        f"the contract defines {missing}, which no class in {CLASSES.name} extracts -- the platform "
        "will report them unavailable on every notice"
    )


@pytest.mark.parametrize("class_id", sorted(_by_id()), ids=lambda v: str(v))
def test_every_class_carries_the_index_keys(class_id: str) -> None:
    """Both keys the notices table indexes on must be extractable, per class.

    :param class_id: the class schema's ``$id``.
    """
    properties = set(_by_id()[class_id]["properties"])
    expected = INDEX_KEYS - ({"notice_date"} if class_id in CLASSES_WITHOUT_NOTICE_DATE else set())
    missing = sorted(expected - properties)
    assert not missing, (
        f"{class_id} cannot extract {missing}. `notice_date` is the notices table's range key and "
        "`counterparty` its hash key: without the first the mapper raises and the document is "
        "dead-lettered, and without the second the notice is stored under the literal `unknown` and "
        "drops out of the agent's query path"
    )


def _ground_truth_keys_by_class() -> dict[str, set[str]]:
    """Field keys the committed ground truth proves are readable off a document of each class.

    The evaluation ground truth is the corpus's own answer key -- a human-reviewed record of what each
    sample document actually says. A key present there and absent from the schema is not a judgement
    call: the value is on the page, and the configuration cannot emit it.

    :returns: a mapping of ``classification`` to the union of its ground-truth field keys.
    :raises AssertionError: when no ground-truth file is found, which would make the assertion below
        pass on an empty set.
    """
    results = sorted(GROUND_TRUTH.rglob("sections/*/result.json"))
    assert results, (
        f"no ground-truth results under {GROUND_TRUTH} -- the corpus check would be vacuous"
    )

    by_class: dict[str, set[str]] = {}
    for path in results:
        section = json.loads(path.read_text())
        class_id = section.get("classification")
        if not class_id:
            continue
        by_class.setdefault(class_id, set()).update((section.get("inference_result") or {}).keys())
    return by_class


def test_every_class_extracts_what_the_corpus_proves_is_on_the_page() -> None:
    """The schema must be able to emit every field the ground truth records for that class.

    This is the assertion that would have caught the drift on its own, without anyone comparing key
    vocabularies by eye: the deployed configuration could not emit `reference` or `fund` for a paydown
    notice, and the corpus ground truth for that very document holds both. They were the ledger join
    key and the fund-alias input -- the two evidence steps that came back empty.

    A class MAY configure more than the corpus needs (the corpus is 16 documents, not every notice a
    real agent bank sends); it may not configure less.
    """
    configured = {class_id: set(schema["properties"]) for class_id, schema in _by_id().items()}
    offenders: dict[str, list[str]] = {}
    for class_id, keys in _ground_truth_keys_by_class().items():
        missing = sorted(keys - configured.get(class_id, set()))
        if missing:
            offenders[class_id] = missing
    assert not offenders, (
        f"{CLASSES.name} cannot extract fields the corpus ground truth records: {offenders} -- the "
        "value is printed on the sample document and the schema has no key to put it under"
    )


@pytest.mark.parametrize("class_id", sorted(_by_id()), ids=lambda v: str(v))
def test_the_two_amount_columns_stay_two_fields(class_id: str) -> None:
    """§5: `Your Share` -> `amount` and `Global Amount` -> `global_amount`, never merged.

    §5 calls this "the single most consequential instruction in this document", and the way it breaks
    in a schema is banal: the two descriptions get copy-pasted and stop telling the model which column
    is which. Identical prose under two keys is the conflation itself, one edit before the notice
    starts reporting a facility-wide total as one fund's amount and the reconciliation compares the
    wrong two numbers with nothing to show for it.

    Whether a class needs both keys at all is a per-document question -- several samples print only a
    global figure, and the consolidated advice prints a wire total that IS the fund's money -- so that
    is left to ``test_every_class_extracts_what_the_corpus_proves_is_on_the_page``.

    :param class_id: the class schema's ``$id``.
    """
    properties = _by_id()[class_id]["properties"]
    if not {"amount", "global_amount"} <= set(properties):
        pytest.skip(f"{class_id} does not configure both amount columns")
    share = properties["amount"].get("description", "")
    total = properties["global_amount"].get("description", "")
    assert share and total and share != total, (
        f"{class_id} describes `amount` and `global_amount` identically -- the schema no longer tells "
        "the model which of the two printed columns is the fund's share"
    )


def test_the_artifact_is_formatted_for_review() -> None:
    """The artifact is 90 KB of prose; an unstable serialisation makes its diffs unreadable.

    Every property description IS an extraction instruction, so review happens in the diff. Keys are
    sorted and the indent fixed so a one-word change to one description shows up as a one-line
    change, and the push script's own summary can be trusted.
    """
    text = CLASSES.read_text()
    canonical = json.dumps(json.loads(text), indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    assert text == canonical, (
        f"{CLASSES.name} is not in canonical form -- re-serialise it with "
        "json.dumps(..., indent=2, sort_keys=True, ensure_ascii=False) so its diffs stay reviewable"
    )

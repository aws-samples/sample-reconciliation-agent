"""Guard tests for the knowledge-base seed corpus and its Bedrock metadata sidecars.

Every document under ``data/kb-seed/`` is retrieved through the AgentCore Gateway
``bedrock-knowledge-bases`` connector, which exposes the Bedrock ``Retrieve`` request's
``managedSearchConfiguration.filter`` to the agent. Filtering is only as good as the metadata, and
almost every way of getting the metadata wrong fails SILENTLY:

- a malformed or misnamed sidecar is ignored by the S3 data-source connector, so the attribute
  simply never appears and every filter on it matches nothing;
- a ``break_class`` that omits a class makes the document unreachable whenever the agent narrows
  by that class;
- Bedrock has no joins, so an attachment's ``sender`` / ``subject`` / ``received_date`` are
  *copies* of its parent email's. A copy that drifts makes a perfectly reasonable filter return
  the email but not its attachments, or vice versa.

The second one is a safety property, not a nicety — see ``test_cross_cutting_playbooks_*``.

The corpus is heterogeneous: ``playbooks/*.md`` is guidance, ``retrieved_emails/*`` is archived
correspondence (``.html``) plus the documents that arrived with it (``.pdf``, ``.xlsx``). The
three ``doc_type`` values therefore require *different* attribute sets, which is why there is no
single ``REQUIRED_ATTRIBUTES`` constant.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
CORPUS_ROOT = REPO_ROOT / "data" / "kb-seed"
SKILLS_ROOT = REPO_ROOT / "agent-blueprint" / "recon-agent" / "skills"
ATTACHMENT_GENERATOR = REPO_ROOT / "scripts" / "generate_kb_email_attachments.py"

# Bedrock's documented sidecar limit. A larger file is rejected outright.
MAX_SIDECAR_BYTES = 10 * 1024

# The closed set of break classes, matching the taxonomy the playbooks describe.
BREAK_CLASSES = frozenset({"timing", "tolerance", "aggregation", "missing_reference", "unknown"})

# Extensions the corpus is allowed to contain. Every one is on Bedrock's supported list for an
# S3 data source (per *Prerequisites for your Amazon Bedrock knowledge base data*: .txt, .md,
# .html, .doc/.docx, .csv, .xls/.xlsx, .pdf). An unsupported extension would be uploaded to S3
# by Terraform and then skipped at ingestion with no error surfaced anywhere.
DOCUMENT_SUFFIXES = frozenset({".md", ".html", ".pdf", ".xlsx"})

# Directory -> the doc_type values documents in it may declare.
DOC_TYPES_BY_DIR = {
    "playbooks": frozenset({"playbook"}),
    "retrieved_emails": frozenset({"email", "email_attachment"}),
}

# Within retrieved_emails/, the doc_type is determined by the extension: the .html file is the
# message body, everything else is one of its attachments.
EMAIL_BODY_SUFFIX = ".html"
ATTACHMENT_SUFFIXES = frozenset({".pdf", ".xlsx"})

# Documents that state policy applying to EVERY break class, and must therefore survive any
# narrowing filter the agent applies.
# `autonomy-and-escalation.md` was here and is gone. Its content — when an item may be resolved without
# a human — moved into the shared-core system prompt, which is ALWAYS present rather than retrieved: a
# rule about when to escalate must not be reachable only by a search that happens to return it. It also
# pointed readers at a `confidence_threshold` skill front-matter key that no skill has ever declared.
CROSS_CUTTING = frozenset({"playbooks/source-selection.md"})

# Bedrock metadata attribute types -> the value key each one requires. BOOLEAN is listed because
# it is part of the documented sidecar schema, not because the corpus may use it -- see
# test_no_sidecar_declares_a_boolean_attribute for why it is banned here.
VALUE_KEY_BY_TYPE = {
    "STRING": "stringValue",
    "NUMBER": "numberValue",
    "BOOLEAN": "booleanValue",
    "STRING_LIST": "stringListValue",
}

# Attributes every document carries, whatever its doc_type. These are the filter axes that must
# work across the whole corpus — in particular `break_class`, so that narrowing by class does
# not silently exclude one kind of document.
SHARED_ATTRIBUTES = frozenset({"doc_type", "break_class", "skill", "effective_date"})

# Attributes an email carries, and that its attachments carry copies of. Bedrock cannot join a
# child document to its parent, so an `andAll` of doc_type=email_attachment + sender only works
# if the attachment repeats the email's fields. `message_id` is what ties the bundle together.
EMAIL_ATTRIBUTES = frozenset({"message_id", "sender", "receiver", "subject", "received_date"})

REQUIRED_ATTRIBUTES_BY_DOC_TYPE = {
    "playbook": SHARED_ATTRIBUTES | {"autonomy"},
    "email": SHARED_ATTRIBUTES | EMAIL_ATTRIBUTES | {"has_attachments"},
    "email_attachment": SHARED_ATTRIBUTES | EMAIL_ATTRIBUTES | {"attachment_format"},
}

# Email addresses in the corpus must be unusable. RFC 2606 / RFC 6761 reserve these for
# documentation and examples, so nothing here can resolve or be delivered to.
RESERVED_REGISTRABLE_DOMAINS = frozenset({"example.com", "example.net", "example.org"})
RESERVED_TLDS = frozenset({"invalid", "test", "example", "localhost"})

ADDRESS_PATTERN = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")


def _documents() -> list[Path]:
    """Return every corpus document, excluding the ``.metadata.json`` sidecars.

    This deliberately globs *everything* and lets ``test_every_document_uses_a_supported_format``
    reject anything unexpected. A glob narrowed to known extensions (``rglob("*.md")``, say) would
    silently ignore a stray file rather than failing on it.

    :return: sorted list of absolute paths to the corpus documents.
    """
    return sorted(
        path
        for path in CORPUS_ROOT.rglob("*")
        if path.is_file() and not path.name.endswith(".metadata.json")
    )


def _sidecar_for(document: Path) -> Path:
    """Return the sidecar path Bedrock expects for a document.

    The S3 data-source connector looks for ``<fileName>.<extension>.metadata.json`` in the SAME
    folder as the document — so ``timing-difference.md`` pairs with
    ``timing-difference.md.metadata.json``, NOT ``timing-difference.metadata.json``. Keeping the
    full extension is what lets ``notice.pdf`` and ``notice.xlsx`` coexist in one folder.

    :param document: path to the corpus document.
    :return: the expected sidecar path (which may not exist).
    """
    return document.with_name(f"{document.name}.metadata.json")


def _load_attributes(document: Path) -> dict:
    """Load and return the ``metadataAttributes`` map for a document's sidecar.

    :param document: path to the corpus document.
    :return: the sidecar's ``metadataAttributes`` mapping.
    """
    return json.loads(_sidecar_for(document).read_text())["metadataAttributes"]


def _value(document: Path, attribute: str) -> object:
    """Return the unwrapped value of one metadata attribute.

    :param document: path to the corpus document.
    :param attribute: the attribute name, e.g. ``"sender"``.
    :return: the ``stringValue`` / ``numberValue`` / ``booleanValue`` / ``stringListValue``.
    """
    wrapper = _load_attributes(document)[attribute]["value"]
    return wrapper[VALUE_KEY_BY_TYPE[wrapper["type"]]]


def _doc_type(document: Path) -> str:
    """Return the declared ``doc_type`` of a document.

    :param document: path to the corpus document.
    :return: ``"playbook"``, ``"email"`` or ``"email_attachment"``.
    """
    return _load_attributes(document)["doc_type"]["value"]["stringValue"]


def _relative(document: Path) -> str:
    """Return the document path relative to the corpus root, with forward slashes.

    :param document: path to the corpus document.
    :return: e.g. ``"playbooks/timing-difference.md"``.
    """
    return document.relative_to(CORPUS_ROOT).as_posix()


def _expected_doc_type(document: Path) -> str:
    """Return the doc_type a document's location and extension imply.

    :param document: path to the corpus document.
    :return: the doc_type it must declare.
    """
    directory = document.relative_to(CORPUS_ROOT).parts[0]
    if directory == "playbooks":
        return "playbook"
    return "email" if document.suffix == EMAIL_BODY_SUFFIX else "email_attachment"


def _reserved_domain(address: str) -> bool:
    """Report whether an email address sits in a reserved, undeliverable domain.

    :param address: the address to check.
    :return: True if its domain is reserved for documentation use.
    """
    labels = address.rsplit("@", 1)[1].lower().split(".")
    return ".".join(labels[-2:]) in RESERVED_REGISTRABLE_DOMAINS or labels[-1] in RESERVED_TLDS


DOCUMENTS = _documents()


def test_the_corpus_is_not_empty() -> None:
    """Fail loudly if the corpus glob finds nothing — otherwise every test below passes vacuously."""
    assert DOCUMENTS, f"no documents found under {CORPUS_ROOT}"


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_every_document_uses_a_supported_format(document: Path) -> None:
    """An extension Bedrock cannot parse is uploaded and then skipped, with no error anywhere.

    :param document: path to the corpus document.
    """
    assert document.suffix in DOCUMENT_SUFFIXES, (
        f"{_relative(document)} has unsupported extension {document.suffix!r}; "
        f"supported: {sorted(DOCUMENT_SUFFIXES)}"
    )


def test_the_corpus_exercises_every_format_the_test_matrix_claims() -> None:
    """The live test plan asserts markdown, HTML, PDF and spreadsheet all ingest and retrieve.

    If one of those formats is absent from the corpus, that assertion passes vacuously and the
    parsing path for the missing format was never actually exercised.
    """
    present = {document.suffix for document in DOCUMENTS}
    assert present == set(DOCUMENT_SUFFIXES), (
        f"corpus is missing {sorted(set(DOCUMENT_SUFFIXES) - present)}"
    )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_every_document_has_a_sidecar(document: Path) -> None:
    """Each document must have a sibling sidecar, or its metadata is simply absent at retrieval.

    :param document: path to the corpus document.
    """
    assert _sidecar_for(document).is_file(), f"missing sidecar for {_relative(document)}"


def test_no_orphaned_sidecars() -> None:
    """A sidecar whose document was renamed or removed is dead weight and silently ignored."""
    orphans = [
        sidecar.relative_to(CORPUS_ROOT).as_posix()
        for sidecar in CORPUS_ROOT.rglob("*.metadata.json")
        if not sidecar.with_name(sidecar.name.removesuffix(".metadata.json")).is_file()
    ]
    assert not orphans, f"sidecars with no document: {orphans}"


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_sidecar_is_within_the_size_limit(document: Path) -> None:
    """Bedrock rejects a sidecar over 10 KB outright.

    :param document: path to the corpus document.
    """
    size = _sidecar_for(document).stat().st_size
    assert size <= MAX_SIDECAR_BYTES, f"{_relative(document)} sidecar is {size} bytes"


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_sidecar_has_only_the_metadata_attributes_key(document: Path) -> None:
    """``metadataAttributes`` is the only documented top-level key; anything else is a typo.

    :param document: path to the corpus document.
    """
    payload = json.loads(_sidecar_for(document).read_text())
    assert set(payload) == {"metadataAttributes"}, (
        f"{_relative(document)} sidecar has unexpected top-level keys: {sorted(payload)}"
    )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_sidecar_declares_exactly_the_attributes_its_doc_type_requires(document: Path) -> None:
    """The filter vocabulary is fixed per doc_type: a missing attribute matches nothing.

    The sets differ by kind, and each difference is deliberate. ``autonomy`` is a property of
    guidance, so an email does not carry it — which is correct behaviour, not an omission: a
    filter on ``autonomy`` should return playbooks only. Conversely ``sender`` on a playbook
    would be meaningless.

    :param document: path to the corpus document.
    """
    doc_type = _doc_type(document)
    declared = set(_load_attributes(document))
    expected = REQUIRED_ATTRIBUTES_BY_DOC_TYPE[doc_type]
    assert declared == set(expected), (
        f"{_relative(document)} (doc_type={doc_type}) declares {sorted(declared)}; "
        f"missing {sorted(expected - declared)}, unexpected {sorted(declared - expected)}"
    )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_every_attribute_has_a_well_formed_typed_value(document: Path) -> None:
    """Each attribute needs ``value`` + ``includeForEmbedding``, and a type-matched value key.

    A ``STRING_LIST`` carrying ``stringValue`` (or vice versa) is accepted by JSON but dropped by
    the connector, so the attribute vanishes with no error anywhere.

    :param document: path to the corpus document.
    """
    for name, attribute in _load_attributes(document).items():
        where = f"{_relative(document)}::{name}"
        assert set(attribute) == {"value", "includeForEmbedding"}, f"{where}: {sorted(attribute)}"
        assert isinstance(attribute["includeForEmbedding"], bool), f"{where}: not a bool"

        value = attribute["value"]
        declared_type = value.get("type")
        assert declared_type in VALUE_KEY_BY_TYPE, f"{where}: bad type {declared_type!r}"
        assert set(value) == {"type", VALUE_KEY_BY_TYPE[declared_type]}, (
            f"{where}: {declared_type} needs exactly "
            f"{{'type', {VALUE_KEY_BY_TYPE[declared_type]!r}}}, got {sorted(value)}"
        )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_doc_type_matches_the_directory_and_extension(document: Path) -> None:
    """``doc_type`` is the corpus's coarsest filter axis, so it must track the layout.

    ``playbooks/`` is all guidance. Inside ``retrieved_emails/`` the split is by extension: the
    ``.html`` file is the message, and the ``.pdf`` / ``.xlsx`` files beside it are what arrived
    attached to it.

    :param document: path to the corpus document.
    """
    directory = document.relative_to(CORPUS_ROOT).parts[0]
    assert directory in DOC_TYPES_BY_DIR, f"{_relative(document)} is in an unknown directory"
    declared = _doc_type(document)
    assert declared in DOC_TYPES_BY_DIR[directory], (
        f"{_relative(document)} declares doc_type={declared!r} under {directory}/"
    )
    assert declared == _expected_doc_type(document), (
        f"{_relative(document)} declares doc_type={declared!r} but its extension implies "
        f"{_expected_doc_type(document)!r}"
    )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_break_classes_are_in_the_closed_set(document: Path) -> None:
    """An unrecognised class is unreachable — no agent-supplied filter will ever name it.

    :param document: path to the corpus document.
    """
    declared = set(_value(document, "break_class"))
    assert declared, f"{_relative(document)} declares no break_class"
    assert declared <= BREAK_CLASSES, (
        f"{_relative(document)}: unknown {sorted(declared - BREAK_CLASSES)}"
    )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_skills_exist_in_the_catalog(document: Path) -> None:
    """``skill`` ties the corpus to the vocabulary Tier-1 emits, so the names must be real.

    ``backend/tier1/classify.py`` returns SKILL NAMES (``record-match-review``,
    ``ledger-status-resolution``), so a typo here breaks the ability to filter guidance by the
    Tier-1 classification.

    :param document: path to the corpus document.
    """
    declared = set(_value(document, "skill"))
    assert declared, f"{_relative(document)} declares no skill"
    known = {path.stem for path in SKILLS_ROOT.glob("*.md")}
    assert declared <= known, f"{_relative(document)}: unknown skills {sorted(declared - known)}"


def test_cross_cutting_playbooks_carry_every_break_class() -> None:
    """Policy documents must survive ANY narrowing filter the agent applies.

    This is the corpus's most important safety property. ``break_class`` is a STRING_LIST queried
    with ``listContains`` precisely so that a document applying to all classes can list all of
    them. A STRING with an ``"any"`` sentinel cannot do that: under ``equals`` a filter for
    ``"aggregation"`` excludes ``"any"``, so the moment the agent narrowed by class it would lose
    sight of the autonomy and escalation rules — and could auto-resolve an item the policy says to
    escalate, *because* it filtered carefully.
    """
    for relative in sorted(CROSS_CUTTING):
        document = CORPUS_ROOT / relative
        assert document.is_file(), f"cross-cutting document {relative} is missing"
        declared = set(_value(document, "break_class"))
        assert declared == set(BREAK_CLASSES), (
            f"{relative} must list every break class so no filter can hide it; "
            f"missing {sorted(BREAK_CLASSES - declared)}"
        )


def test_every_break_class_has_a_dedicated_playbook() -> None:
    """Every class needs its own methodology document, not just the cross-cutting policy.

    Coverage is measured over the NON-cross-cutting playbooks on purpose. The two cross-cutting
    documents list all five classes so no filter can hide them, which means a union taken over
    *all* playbooks is complete by construction and can never fail — the test would pass on a
    corpus containing nothing but the escalation policy.

    Measured this way it asserts the property that matters: filtering to a class returns actual
    guidance on reconciling it, rather than only the rules about when to escalate.
    """
    covered: set[str] = set()
    for document in DOCUMENTS:
        if _doc_type(document) == "playbook" and _relative(document) not in CROSS_CUTTING:
            covered |= set(_value(document, "break_class"))
    assert covered == set(BREAK_CLASSES), (
        f"no class-specific playbook covers {sorted(BREAK_CLASSES - covered)}"
    )


def test_the_email_archive_spans_more_than_one_break_class() -> None:
    """A single-class archive makes every class-filtered retrieval over emails unfalsifiable.

    If every email were tagged ``aggregation``, a filter for ``aggregation`` and a filter for
    "everything" return the same set, and the live matrix cannot show that class filtering
    discriminates within the archive.
    """
    covered: set[str] = set()
    for document in DOCUMENTS:
        if _doc_type(document) in {"email", "email_attachment"}:
            covered |= set(_value(document, "break_class"))
    assert len(covered) > 1, f"the email archive only covers {sorted(covered)}"


def _emails_by_message_id() -> dict[str, Path]:
    """Index the email bodies by ``message_id``.

    :return: mapping of message_id to the ``.html`` document declaring it.
    """
    index: dict[str, Path] = {}
    for document in DOCUMENTS:
        if _doc_type(document) == "email":
            message_id = _value(document, "message_id")
            assert message_id not in index, (
                f"message_id {message_id!r} claimed by both "
                f"{_relative(index[message_id])} and {_relative(document)}"
            )
            index[message_id] = document
    return index


ATTACHMENTS = [document for document in DOCUMENTS if _doc_type(document) == "email_attachment"]


def test_there_is_at_least_one_attachment() -> None:
    """Guard the attachment tests below against passing vacuously on an empty list."""
    assert ATTACHMENTS, "no email_attachment documents found"


@pytest.mark.parametrize("attachment", ATTACHMENTS, ids=_relative)
def test_every_attachment_belongs_to_an_email_in_the_corpus(attachment: Path) -> None:
    """An attachment whose ``message_id`` matches no email is an orphan the agent cannot trace.

    The whole point of ``message_id`` is that retrieving an attachment lets the agent pull the
    covering message (and vice versa) with an ``equals`` filter. A dangling id breaks that.

    :param attachment: path to the attachment document.
    """
    message_id = _value(attachment, "message_id")
    assert message_id in _emails_by_message_id(), (
        f"{_relative(attachment)} references unknown message_id {message_id!r}"
    )


@pytest.mark.parametrize("attachment", ATTACHMENTS, ids=_relative)
def test_attachment_repeats_its_parent_emails_metadata_exactly(attachment: Path) -> None:
    """Bedrock has no joins, so the parent's filter fields are copied — and copies drift.

    ``andAll(doc_type=email_attachment, sender=X)`` only works because the attachment repeats the
    email's ``sender``. If the two disagree, a filter returns the message but not the schedule
    that explains it, and the agent reasons from half the evidence with nothing signalling that
    anything is missing.

    :param attachment: path to the attachment document.
    """
    email = _emails_by_message_id()[_value(attachment, "message_id")]
    for name in sorted(EMAIL_ATTRIBUTES):
        assert _value(attachment, name) == _value(email, name), (
            f"{_relative(attachment)}::{name} = {_value(attachment, name)!r} but "
            f"{_relative(email)}::{name} = {_value(email, name)!r}"
        )


@pytest.mark.parametrize("attachment", ATTACHMENTS, ids=_relative)
def test_attachment_format_matches_the_file_extension(attachment: Path) -> None:
    """``attachment_format`` exists so the agent can ask for spreadsheets over prose, or vice
    versa. Declaring ``pdf`` on an ``.xlsx`` makes that filter actively misleading.

    :param attachment: path to the attachment document.
    """
    assert attachment.suffix in ATTACHMENT_SUFFIXES, f"{_relative(attachment)} is not an attachment"
    assert _value(attachment, "attachment_format") == attachment.suffix.removeprefix("."), (
        f"{_relative(attachment)} declares attachment_format="
        f"{_value(attachment, 'attachment_format')!r}"
    )


def test_has_attachments_is_truthful() -> None:
    """``has_attachments`` is the easiest value in the corpus to leave stale.

    An email claiming ``"true"`` with nothing beside it sends the agent looking for a schedule that
    was never indexed; claiming ``"false"`` when there is one hides evidence it should have read.
    """
    attachment_ids = {_value(attachment, "message_id") for attachment in ATTACHMENTS}
    for message_id, email in sorted(_emails_by_message_id().items()):
        declared = _value(email, "has_attachments")
        expected = "true" if message_id in attachment_ids else "false"
        assert declared == expected, (
            f"{_relative(email)} declares has_attachments={declared!r} but the corpus has "
            f"{'at least one' if expected == 'true' else 'no'} attachment for {message_id!r}"
        )


@pytest.mark.parametrize("document", DOCUMENTS, ids=_relative)
def test_no_sidecar_declares_a_boolean_attribute(document: Path) -> None:
    """No sidecar may use ``type: BOOLEAN`` -- the managed KB connector DROPS such a document.

    ⚠️ This is not style. A single BOOLEAN attribute in a ``.metadata.json`` sidecar makes the
    MANAGED knowledge base's S3 connector discard the document entirely, and every signal you would
    look at lies about it (verified live 2026-08-26 against KB 50K9JVEJTH):

    * the ingestion job reports ``COMPLETE``;
    * ``numberOfDocumentsFailed`` can read ``0`` while documents are missing;
    * ``failureReasons`` says only "Some documents could not be crawled";
    * ``ListKnowledgeBaseDocuments`` does not list the document AT ALL -- not even as ``FAILED``,
      so there is no ``statusReason`` to read.

    The cause was isolated by uploading the same email body twice, with sidecars differing only in
    the presence of one BOOLEAN attribute: the one without it indexed, the one with it vanished.
    BOOLEAN is nevertheless *documented* as a supported sidecar type, so nothing but this test will
    stop it coming back. Model a two-valued attribute as a STRING of ``"true"`` / ``"false"``.

    :param document: path to the corpus document.
    """
    offenders = sorted(
        name
        for name, attribute in _load_attributes(document).items()
        if attribute["value"]["type"] == "BOOLEAN"
    )
    assert not offenders, (
        f"{_relative(document)} declares BOOLEAN attribute(s) {offenders}; the managed KB "
        'connector silently drops the document. Use a STRING of "true"/"false" instead.'
    )


@pytest.mark.parametrize(
    "document",
    [document for document in DOCUMENTS if _doc_type(document) != "playbook"],
    ids=_relative,
)
def test_received_date_agrees_with_effective_date(document: Path) -> None:
    """``effective_date`` is the corpus-wide time axis; ``received_date`` is the email-native name.

    Both exist on purpose: a range filter over the *whole* corpus needs one attribute present on
    every document, and an agent reasoning about correspondence will reach for ``received_date``.
    For a message the two mean the same thing, so they must be equal — otherwise the same
    ``lessThan`` bound returns different sets depending on which name the model happened to pick,
    which is the kind of divergence nothing else would ever surface.

    :param document: path to an email or attachment document.
    """
    assert _value(document, "received_date") == _value(document, "effective_date"), (
        f"{_relative(document)}: received_date={_value(document, 'received_date')} != "
        f"effective_date={_value(document, 'effective_date')}"
    )


def test_the_email_archive_spans_several_dates() -> None:
    """The live matrix's date-selectivity cases need a bound that splits the archive in two.

    A range filter can only be *shown* to work if some documents fall inside the bound and others
    outside. Back-dating one document to manufacture that would make the case vacuous; the archive
    gets it honestly, since correspondence genuinely arrives on different days (June-August 2026)
    while the playbooks carry their authoring date.

    Asserting three or more distinct dates leaves room for a bound with documents strictly on
    both sides of it, which two dates does not guarantee.
    """
    dates = sorted(
        {
            _value(document, "received_date")
            for document in DOCUMENTS
            if _doc_type(document) != "playbook"
        }
    )
    assert len(dates) >= 3, f"the archive only spans {dates} — a range filter cannot discriminate"


def _scannable_sources() -> list[Path]:
    """Return every file whose text should be swept for email addresses.

    Covers the sidecars and the text documents directly. ``.pdf`` is included because the
    generator writes uncompressed content streams, so its text is greppable in the raw bytes.
    ``.xlsx`` is a compressed zip and cannot be scanned this way — the generator script is
    scanned instead, since it is the sole source of every spreadsheet cell value.

    :return: sorted list of paths to sweep.
    """
    scannable = [
        path
        for path in CORPUS_ROOT.rglob("*")
        if path.is_file() and path.suffix in {".md", ".html", ".pdf", ".json"}
    ]
    return sorted([*scannable, ATTACHMENT_GENERATOR])


@pytest.mark.parametrize("source", _scannable_sources(), ids=lambda path: path.name)
def test_every_address_uses_a_reserved_domain(source: Path) -> None:
    """No real email address may enter the corpus.

    This corpus is committed to git *and* uploaded to S3 *and* indexed into a knowledge base the
    agent quotes back in its reasoning. A genuine counterparty address landing here is an
    undetected data leak in three places at once, and secret scanners do not flag email
    addresses — gitleaks looks for credentials, not correspondents. So the only defence is that
    every domain is reserved by RFC 2606 / RFC 6761 and therefore cannot resolve.

    :param source: path to the file being swept.
    """
    assert source.is_file(), f"{source} is missing — the sweep would pass vacuously"
    text = source.read_text(encoding="utf-8", errors="replace")
    offenders = sorted(
        {address for address in ADDRESS_PATTERN.findall(text) if not _reserved_domain(address)}
    )
    assert not offenders, f"{source.name} contains non-reserved addresses: {offenders}"

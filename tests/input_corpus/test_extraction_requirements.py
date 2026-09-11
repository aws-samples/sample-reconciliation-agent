"""The IDP extraction contract and the mapper must agree, in both directions.

``data/input/IDP-EXTRACTION-REQUIREMENTS.md`` is the contract handed to whoever configures the
document-processing solution. ``backend/idp_hook/mapper.py`` reads the extraction result by LITERAL KEY
NAME, so the two drifting apart fails in a way nothing reports:

* a key the mapper reads but the contract omits — nobody is asked to extract it, and the field arrives
  as ``fields_unavailable``, which the agent reads as "this notice class does not carry that field"
  rather than as a gap;
* a key the mapper PROMOTES that nothing pins — an attribute recon must keep in step with a
  configuration in another repository, bought for no reason.

Note which direction is NOT guarded: a contract key the mapper does not read is fine, because
``idp_sections`` carries every extracted field verbatim and it still reaches its consumer. What needs
guarding is GROWTH of the promoted set, not gaps in it.

⚠️ The mapper's key set is derived with ``ast``, deliberately NOT with a regex over ``_opt(fields, …)``.
Four keys are read outside that call shape, and they are the load-bearing ones::

    fields.get("notice_date") or fields.get("value_date")     # notice_date is the index RANGE key
    fields.get("counterparty") or fields.get("borrower")      # counterparty is its HASH key

A regex over ``_opt`` finds five keys and misses those four, so it would pass on a contract that
omitted both index keys — false assurance on the only two fields whose absence breaks retrieval
outright.
"""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

from backend.recon_core.notices import PROMOTED_EXTRACTED_FIELDS

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT = REPO_ROOT / "data" / "input" / "IDP-EXTRACTION-REQUIREMENTS.md"
MAPPER = REPO_ROOT / "backend" / "idp_hook" / "mapper.py"
INPUT_DIR = REPO_ROOT / "data" / "input"

# The name the mapper binds the extracted-field map to. Every read this test collects is a read of
# THIS local, which is what keeps it from also collecting unrelated dict lookups.
FIELDS_LOCAL = "fields"


# Section-level keys the contract is required to document. IDP's own envelope keys (`Id`, `PageIds`,
# `OutputJSONUri`, …) are deliberately NOT here: they are transport, not extraction output, and
# demanding them in a contract aimed at an extraction author would be noise.
SECTION_KEYS = frozenset({"classification", "classification_confidence", "confidence_alert_count"})

# Markdown table rows look like `| a | b | c |`. A row of dashes is the header separator.
_ROW = re.compile(r"^\|(?P<cells>.+)\|\s*$")
_SEPARATOR = re.compile(r"^[\s|:-]+$")
# Contract values are written in backticks; a cell may hold several (`a`, `b`).
_CODE = re.compile(r"`([^`]+)`")


def _section(heading_prefix: str) -> str:
    """Return the body of one `##` section of the contract, by heading prefix.

    :param heading_prefix: the text the heading starts with after `## `, e.g. ``"2. Field keys"``.
    :returns: the section body, up to the next `##` heading or `---` rule.
    :raises AssertionError: when no heading matches — a renamed heading must fail loudly rather than
        silently yielding an empty section, which would make every assertion below vacuous.
    """
    text = CONTRACT.read_text()
    start = text.find(f"## {heading_prefix}")
    assert start != -1, f"contract has no '## {heading_prefix}' section"
    rest = text[start + 3 :]
    end = min(
        (pos for pos in (rest.find("\n## "), rest.find("\n---")) if pos != -1),
        default=len(rest),
    )
    return rest[:end]


def _first_column(section_body: str) -> set[str]:
    """Collect the backticked values in the first column of every table row in a section.

    :param section_body: the markdown body to scan.
    :returns: the set of values found.
    """
    found: set[str] = set()
    for line in section_body.splitlines():
        match = _ROW.match(line.strip())
        if not match or _SEPARATOR.match(line.strip()):
            continue
        first_cell = match.group("cells").split("|")[0]
        found.update(_CODE.findall(first_cell))
    return found


def _mapper_field_keys() -> set[str]:
    """Every literal key the mapper reads out of the extracted-field map.

    Collects three read shapes over the ``fields`` local: ``_opt(fields, "k")`` /
    ``_opt_decimal(fields, "k")``, ``fields.get("k")`` and ``fields["k"]``.

    :returns: the set of key names.
    """
    tree = ast.parse(MAPPER.read_text())
    keys: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            # _opt(fields, "k") / _opt_decimal(fields, "k")
            if (
                isinstance(func, ast.Name)
                and func.id in {"_opt", "_opt_decimal"}
                and len(node.args) >= 2
                and isinstance(node.args[0], ast.Name)
                and node.args[0].id == FIELDS_LOCAL
                and isinstance(node.args[1], ast.Constant)
            ):
                keys.add(node.args[1].value)
            # fields.get("k")
            if (
                isinstance(func, ast.Attribute)
                and func.attr == "get"
                and isinstance(func.value, ast.Name)
                and func.value.id == FIELDS_LOCAL
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                keys.add(node.args[0].value)
        # fields["k"]
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == FIELDS_LOCAL
            and isinstance(node.slice, ast.Constant)
        ):
            keys.add(node.slice.value)
    return keys


def _roadmap_keys() -> set[str]:
    """Keys the contract lists as not-yet-read, which the parity assertion must exclude.

    :returns: the set of roadmap key names.
    """
    text = CONTRACT.read_text()
    start = text.find("## Roadmap")
    assert start != -1, "contract has no '## Roadmap' section"
    return _first_column(text[start:])


def test_the_mapper_reads_no_extracted_field_by_name() -> None:
    """The strongest form this guard can take, and the point of the whole de-promotion.

    The mapper reads NOTHING out of the extraction by literal key. Every extracted field is carried into
    `idp_sections` verbatim and `search_notices` resolves filters against that map, so a field the
    pipeline adds or renames needs no change anywhere in recon.

    ⚠️ A single key appearing here is a regression, not a detail. A promoted name is one recon must keep
    in step with a configuration in another repository, and when it drifts `_opt`-style reads return None,
    the row stores the field as ABSENT, and the agent reads "this notice class does not carry that field"
    -- extraction still scores well and nothing errors. That silent false negative is what this asserts
    away. If a name genuinely must come back, it has to clear the bar in PROMOTED_EXTRACTED_FIELDS
    (`backend/recon_core/notices.py`): something must be UNABLE to read a nested map. Nothing is, now that
    the two GSIs keyed on extracted fields are gone.
    """
    read = _mapper_field_keys()
    assert read == set(), (
        f"the mapper reads {sorted(read)} out of the extraction by literal key; extracted content is "
        "carried in idp_sections and needs no promotion"
    )


def test_the_promoted_field_list_is_empty() -> None:
    """Asserted separately from the mapper, because the two could drift apart in either direction.

    A name in the tuple with no matching read is a stale claim; a read with no tuple entry is the
    coupling itself. Both are caught by pinning the tuple at empty.
    """
    assert set(PROMOTED_EXTRACTED_FIELDS) == set(), (
        f"PROMOTED_EXTRACTED_FIELDS is no longer empty: {sorted(PROMOTED_EXTRACTED_FIELDS)}"
    )


def test_contract_documents_the_section_level_keys() -> None:
    """The three semantic section keys are part of the contract, not just the field map."""
    documented = _first_column(_section("3. Section-level keys"))
    assert documented == set(SECTION_KEYS), (
        f"section-key table declares {sorted(documented)}, expected {sorted(SECTION_KEYS)}"
    )


def _class_rows() -> list[tuple[str, str]]:
    """Return (class value, folder) for every row of the document-classes table.

    :returns: a list of pairs, in document order.
    """
    rows: list[tuple[str, str]] = []
    for line in _section("1. Document classes").splitlines():
        match = _ROW.match(line.strip())
        if not match or _SEPARATOR.match(line.strip()):
            continue
        cells = match.group("cells").split("|")
        names = _CODE.findall(cells[0])
        folders = _CODE.findall(cells[1]) if len(cells) > 1 else []
        if names and folders:
            rows.append((names[0], folders[0]))
    return rows


def test_the_class_table_is_not_empty() -> None:
    """Guard the two tests below against passing vacuously on a parse failure."""
    assert _class_rows(), "no document-class rows parsed out of the contract"


@pytest.mark.parametrize("class_name,folder", _class_rows(), ids=lambda v: str(v))
def test_every_documented_class_has_a_sample(class_name: str, folder: str) -> None:
    """A class with no sample document cannot be built against.

    :param class_name: the ``classification`` value.
    :param folder: the folder under ``data/input/`` holding its samples.
    """
    directory = INPUT_DIR / folder.rstrip("/")
    assert directory.is_dir(), f"{class_name}: folder {folder} does not exist"
    assert any(directory.glob("*.pdf")), f"{class_name}: no sample document in {folder}"


# Folders under `data/input/` that are NOT document families, so the class table is not expected to
# name them. `idp-evaluation/` holds derived evaluation artefacts: copies of the corpus paired with
# generated ground truth, regrouped by test-set family instead of by class. Every PDF under it is a
# byte-identical copy of one already covered by a folder the table does name — see its README.
NON_FAMILY_FOLDERS = frozenset({"idp-evaluation"})


def test_every_input_folder_is_named_by_a_class() -> None:
    """A folder no class points at is a document family nobody was asked to extract."""
    documented = {folder.rstrip("/") for _, folder in _class_rows()}
    present = {
        path.name for path in INPUT_DIR.iterdir() if path.is_dir() and not path.name.startswith(".")
    }
    orphans = sorted(present - documented - NON_FAMILY_FOLDERS)
    assert not orphans, f"folders under data/input/ that no documented class names: {orphans}"

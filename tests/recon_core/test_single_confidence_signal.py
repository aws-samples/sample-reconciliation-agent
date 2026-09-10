"""One confidence, and only one: the computed evidence-completeness score.

No model-reported confidence number exists anywhere in the trees scanned here. Each such number had a
plausible-sounding purpose and none was read by any gate; the one that WAS read — a 0.6 floor on the
model's own classification confidence — had a single recorded production effect, and it was a mass
false-negative. This file fails if any of them comes back.

The scan is deliberately crude: a substring over source text, with no exemption for comments. That
means a comment explaining why one of these is gone must describe the field in prose rather than spell
its identifier, which is a real cost — paid on purpose, because an exemption list is the seam through
which a reintroduced producer would eventually slip back in.
"""

import pathlib

import pytest

# Source trees only. `data/`, `backend/idp_hook/` and `tests/input_corpus/` are excluded on purpose:
# `classification_confidence` is ALSO an IDP per-section extraction confidence, a completely different
# quantity that is still live and still consumed by the gateway's low-confidence alert gate.
#
# The frontend is in scope because the BFF route types and the case/dashboard views are a producer of
# these names just as much as the Python is, and a reintroduction there would otherwise pass CI in
# silence.
ROOTS = [
    "backend/harness_agent",
    "backend/recon_core",
    "agent-blueprint",
    "chatbot-app/frontend/src",
]
BANNED = ["verbalized_confidence", "DEFAULT_CLASS_THRESHOLD"]

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]

# The one file that must NAME the banned identifiers: it is the detector, a prompt lint whose whole job
# is to flag a system prompt that asks the model for a self-reported number, including one that spells a
# deleted field name. Excluded from the negative scan and asserted POSITIVELY below, so this cannot rot
# into a blanket pass on a file that has stopped being the detector.
_DETECTOR = "chatbot-app/frontend/src/lib/promptPolicyLint.ts"


def _sources() -> list[pathlib.Path]:
    """Every Python/Markdown/JSON/TypeScript source file in the agent backends and the frontend.

    Paths are resolved against the repo root rather than the process CWD so the guard means the same
    thing however pytest was invoked — a CWD-relative glob silently matches nothing and passes.

    :returns: the paths to scan, excluding compiled caches and the detector itself.
    """
    files: list[pathlib.Path] = []
    for root in ROOTS:
        for pattern in ("**/*.py", "**/*.md", "**/*.json", "**/*.ts", "**/*.tsx"):
            files += [p for p in (_REPO_ROOT / root).glob(pattern) if "__pycache__" not in p.parts]
    return [p for p in files if p != _REPO_ROOT / _DETECTOR]


@pytest.mark.parametrize("root", ROOTS)
def test_the_scan_actually_reaches_every_root(root: str) -> None:
    """Guard the guard: an empty file list makes every assertion below vacuously true.

    Per-root rather than a single total, because a total hides the failure that actually happens — one
    mistyped or moved root contributing nothing while the others keep the count healthy.

    :param root: the source tree that must contribute at least one scanned file.
    :returns: None.
    """
    prefix = _REPO_ROOT / root
    reached = [p for p in _sources() if p.is_relative_to(prefix)]
    assert reached, f"the source scan found no files under {root!r} — ROOTS is wrong"


def test_the_detector_still_names_what_it_excludes_itself_for() -> None:
    """The exclusion in ``_sources`` is only sound while that file is still the detector.

    If the prompt lint's rule is deleted or its identifiers renamed, the exclusion would silently
    become a hole in the scan. Assert the reason for it instead of trusting the path.

    :returns: None.
    """
    text = (_REPO_ROOT / _DETECTOR).read_text()

    for term in ["verbalized_confidence", "classification_confidence", "confidence in \\[0,"]:
        assert term in text, f"{_DETECTOR} no longer matches {term!r} — drop the exclusion instead"


@pytest.mark.parametrize("term", BANNED)
def test_no_backend_source_mentions_a_deleted_confidence(term: str) -> None:
    """No source under either agent backend may name a removed confidence field.

    :param term: the banned identifier.
    :returns: None.
    """
    offenders = [str(p.relative_to(_REPO_ROOT)) for p in _sources() if term in p.read_text()]
    assert not offenders, f"{term!r} is back in: {offenders}"


def test_classification_confidence_is_gone_from_the_recon_backends() -> None:
    """Separate from BANNED because the bare string legitimately appears under ``backend/idp_hook/``.

    That directory is not in ROOTS — the assertion is that the name is absent from the AGENT backends
    specifically, not from the repo.

    :returns: None.
    """
    offenders = [
        str(p.relative_to(_REPO_ROOT))
        for p in _sources()
        if "classification_confidence" in p.read_text().replace("idp_classification_confidence", "")
    ]
    assert not offenders, f"classification_confidence is back in: {offenders}"


def test_the_only_confidence_on_a_proposal_is_the_computed_one() -> None:
    """A field-level assertion, so the guard survives a rename the grep-style tests would miss.

    :returns: None.
    """
    from backend.recon_core.schema import Proposal

    confidence_fields = [f for f in Proposal.model_fields if "confidence" in f]
    assert sorted(confidence_fields) == ["confidence", "confidence_components"]


def test_the_classification_result_carries_no_number() -> None:
    """The other half of the pair: the classifier returns a label and a why, nothing scored.

    :returns: None.
    """
    from backend.recon_core.schema import ClassificationResult

    assert [f for f in ClassificationResult.model_fields if "confidence" in f] == []

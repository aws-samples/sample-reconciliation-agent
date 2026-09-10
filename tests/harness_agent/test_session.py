"""Session-id parser regression guard.

The parser and the generator drifted and nothing caught it: the old tests asserted against
INVENTED session ids in a ``recon-<item>-<attempt>-<uuid>`` shape nothing ever produced, so they
passed green while the production regex matched literally zero real sessions and the analyst-
agreement evaluator abstained on every invocation for weeks.

So the fixtures here are REAL session ids, copied verbatim out of
``/aws/lambda/recon-dev-eval-agreement`` and the online-eval results log groups, plus a round
trip through the actual generator. Do not replace them with synthesised ids.
"""

import re

import pytest

from backend.harness_agent.session import item_id_from_session
from backend.tier1.invoke_agent import _session_id

# Verbatim from CloudWatch. Every one of these failed the pre-fix regex.
REAL_SESSION_IDS = [
    # Console-created manual items.
    (
        "recon-manual-scenario1-1-i0kq9a-ae0fb66653eca24dc606dac286de6943",
        "manual-scenario1-1-i0kq9a",
    ),
    # A QA item id that is itself hyphen-rich and upper-case.
    (
        "recon-RECON-QA-0909-010436-BADMODEL-6bc81c36f033ac1e5965a854cef8",
        "RECON-QA-0909-010436-BADMODEL",
    ),
    # IDP-derived: dots and colons already sanitised to '-', leaving only a 6-char hash fragment.
    (
        "recon-idp-PML-20260815-011001-NJ---530477446_Redacted-pdf-2f9fa1",
        "idp-PML-20260815-011001-NJ---530477446_Redacted-pdf",
    ),
    # Same shape with an underscore surviving sanitisation and a 7-char fragment.
    (
        "recon-idp-STD-20260817-191618-STD_530477346_Redacted-pdf-17e5013",
        "idp-STD-20260817-191618-STD_530477346_Redacted-pdf",
    ),
    # Short item id, so most of the sha256 survives the [:64] truncation.
    ("recon-verify-ns-70ce39-a51b74424c72793ec6b33b3090a6090e0c4dc6262", "verify-ns-70ce39"),
]


@pytest.mark.parametrize(("session_id", "expected"), REAL_SESSION_IDS)
def test_real_session_ids_parse(session_id: str, expected: str):
    """Every real session id observed in production must yield its sanitised item id."""
    # All of these are exactly 64 characters: the generator's truncation ceiling.
    assert len(session_id) == 64
    assert item_id_from_session(session_id) == expected


@pytest.mark.parametrize(
    "item_id",
    [
        "idp-Notice.pdf",  # a dot: the case the sanitisation exists for
        "manual-scenario1-1-i0kq9a",
        "idp-PML-20260815-011001-NJ:::530477446_Redacted.pdf",
        "RECON-QA-0909-010436-BADMODEL",
        "a",  # shortest plausible id — hash fragment is at its longest
        "x" * 56,  # the recoverable ceiling: exactly one hash character survives
    ],
)
def test_round_trip_through_the_real_generator(item_id: str):
    """Generate a session id the way Tier-1 does, then recover what the lessons side compares.

    The evaluator matches by sanitising each lessons row and comparing for equality, so what the
    parser must recover is the SANITISED item id — not the raw one, which is unrecoverable.
    """
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", item_id)
    assert item_id_from_session(_session_id(item_id)) == sanitized


def test_dotted_and_hyphenated_ids_are_indistinguishable_after_sanitising():
    """Sanitisation is lossy by construction; both ids collapse to one parse result.

    This is why matching happens on the sanitised side rather than by reversing the parse.
    """
    assert item_id_from_session(_session_id("idp-Notice.pdf")) == "idp-Notice-pdf"
    assert item_id_from_session(_session_id("idp-Notice-pdf")) == "idp-Notice-pdf"


@pytest.mark.parametrize(
    ("session_id", "expected"),
    [
        # The console's retry action: recon-<safe>-retry-<epoch millis>.
        ("recon-idp-Notice-pdf-retry-1789055117664", "idp-Notice-pdf"),
        # The console's reprocess action: recon-<safe>-reprocess-<count>, right-padded with '0'
        # to the 33-character minimum — which keeps the trailing segment digits-only.
        ("recon-idp-Notice-pdf-reprocess-2000000000000", "idp-Notice-pdf"),
    ],
)
def test_console_retry_and_reprocess_shapes_parse(session_id: str, expected: str):
    """The BFF builds a second shape; a digits-only tail must not be read as a hash fragment."""
    assert item_id_from_session(session_id) == expected


@pytest.mark.parametrize(
    "session_id",
    [
        "",
        None,
        # A hand-made QA session that is not a recon session at all (seen in the eval logs).
        "l29-runtime-kbfilter-verify-20260827-0001",
        "not-a-recon-session",
        "recon-",  # prefix only: no item id
        "recon-noseparator",  # no hash segment
        "recon-idp-1-zzzz",  # trailing segment is not hex
    ],
)
def test_non_recon_ids_do_not_parse(session_id):
    """Anything that is not a recon session id must return None so the evaluator abstains."""
    assert item_id_from_session(session_id) is None


def test_over_long_item_ids_are_truncated_and_cannot_produce_a_false_match():
    """Past 56 sanitised characters the generator cuts into the item id itself.

    The parser then returns None or a PREFIX — never a different id — and the evaluator's exact
    equality check turns a prefix into no match, i.e. an abstain. Locking that in: the recovered
    value must never equal the full sanitised item id, because scoring a long case against a
    wrong-but-plausible id is worse than not scoring it.
    """
    long_item = "idp-" + "-".join(["segment"] * 9) + ".pdf"  # 75 sanitised characters
    sanitized = re.sub(r"[^a-zA-Z0-9_-]", "-", long_item)
    assert len(sanitized) > 56
    session_id = _session_id(long_item)
    assert len(session_id) == 64
    parsed = item_id_from_session(session_id)
    assert parsed != sanitized
    assert parsed is None or sanitized.startswith(parsed)

"""Tests for the Tier-1 deterministic general-ledger match (auto-clear path).

The deterministic match keys on the cash item's economic identity — borrower (account name),
entry type (CREDIT/DEBIT derived from the document class), and amount within tolerance — and
NEVER on the document filename/reference. It auto-clears only on a unique surviving GL row.
"""

from backend.recon_core.schema import ReconItem
from backend.tier1.gl_match import (
    GL_AMBIGUOUS,
    GL_NO_BORROWER,
    GL_NO_ENTRY_TYPE,
    GL_QUERY_FAILED,
    GL_ZERO,
    _derive_entry_type,
    extract_candidate_amounts,
    gl_lookup,
)


def _item(*, idp_class="InterestPaymentNotice", borrower="CASCADE LOGISTICS HOLDINGS INC."):
    """Build an IDP-sourced item with a borrower + amounts + document class."""
    return ReconItem(
        item_id="idp-Paydown_and_Interest_Notice.pdf",
        domain="cash",
        sides=[],
        source_refs=["idp:documentId=Paydown_and_Interest_Notice.pdf"],
        attributes={
            "idp_class": idp_class,
            "idp_attributes": {
                "BorrowerName": borrower,
                "InterestPayments": [
                    {"Description": "Term SOFR Term", "TotalPaymentAmount": "2052425.7"}
                ],
                "RepaymentOutstandings": [{"GlobalAmount": 400000.0}],
                "NoticeDate": "26-Dec-2026",  # non-amount: must be ignored
            },
        },
    )


ITEM = _item()


def _row(entry_id, amount, *, borrower="CASCADE LOGISTICS HOLDINGS INC.", entry_type="CREDIT"):
    """A GL row as the gl-query Lambda would return it (all-string values)."""
    return {
        "entry_id": entry_id,
        "borrower": borrower,
        "entry_type": entry_type,
        "amount": str(amount),
    }


class _FakeInvoker:
    """Stands in for the gl-query Lambda invocation."""

    def __init__(self, rows):
        self._rows = rows
        self.requests = []

    def __call__(self, payload: dict) -> dict:
        self.requests.append(payload)
        return {"rows": self._rows, "count": len(self._rows)}


def test_extract_candidate_amounts_finds_numeric_amountish_leaves():
    amounts = extract_candidate_amounts(ITEM)
    assert 2052425.7 in amounts
    assert 400000.0 in amounts
    # No date-derived garbage.
    assert all(a > 0 for a in amounts)


def test_derive_entry_type_from_class():
    assert _derive_entry_type(_item(idp_class="InterestPaymentNotice")) == "CREDIT"
    assert _derive_entry_type(_item(idp_class="OptionalPaydownNotice")) == "CREDIT"
    assert _derive_entry_type(_item(idp_class="LoanDrawCancellationNotice")) == "DEBIT"
    # Absent or unrecognised class -> underivable (escalates).
    assert _derive_entry_type(_item(idp_class=None)) is None
    assert _derive_entry_type(_item(idp_class="SomethingElse")) is None


def test_gl_lookup_matches_on_borrower_entry_type_and_amount():
    fake = _FakeInvoker([_row("GL-1", "2052425.70")])
    matched = gl_lookup(ITEM, invoker=fake).row
    assert matched is not None
    assert matched["entry_id"] == "GL-1"
    # Looked up by the borrower (account name), NOT the document reference.
    assert fake.requests[0] == {"borrower": "CASCADE LOGISTICS HOLDINGS INC."}
    assert "reference" not in fake.requests[0]


def test_gl_lookup_entry_type_mismatch_refutes_even_when_amount_matches():
    # Right amount + right borrower but wrong direction (DEBIT vs the item's CREDIT) -> no match.
    fake = _FakeInvoker([_row("GL-1", "2052425.70", entry_type="DEBIT")])
    assert gl_lookup(ITEM, invoker=fake).row is None


def test_gl_lookup_ambiguous_multiple_rows_escalates():
    # Two GL rows both match borrower + CREDIT + an item amount -> ambiguous -> escalate (None).
    rows = [_row("GL-1", "2052425.70"), _row("GL-2", "400000.00")]
    assert gl_lookup(ITEM, invoker=_FakeInvoker(rows)).row is None


def test_gl_lookup_no_amount_match_returns_none():
    assert gl_lookup(ITEM, invoker=_FakeInvoker([_row("GL-9", "999.99")])).row is None
    assert gl_lookup(ITEM, invoker=_FakeInvoker([])).row is None


def test_gl_lookup_missing_borrower_returns_none():
    item = _item()
    item.attributes["idp_attributes"].pop("BorrowerName")
    assert gl_lookup(item, invoker=_FakeInvoker([_row("GL-1", "2052425.70")])).row is None


def test_gl_lookup_underivable_entry_type_returns_none():
    item = _item(idp_class=None)
    assert gl_lookup(item, invoker=_FakeInvoker([_row("GL-1", "2052425.70")])).row is None


def test_gl_lookup_fail_soft_on_invoker_error():
    def boom(_payload):
        raise RuntimeError("athena down")

    assert gl_lookup(ITEM, invoker=boom).row is None  # never blocks the pipeline


# ---------------------------------------------------------------------------------
# Task 7: the GL failure reason travels with the result instead of only being logged
# ---------------------------------------------------------------------------------


def test_single_match_returns_the_row_and_no_reason():
    got = gl_lookup(ITEM, invoker=_FakeInvoker([_row("GL-1", "2052425.70")]))
    assert got.row["entry_id"] == "GL-1" and got.reason is None


def test_two_matches_report_ambiguous():
    """The load-bearing distinction: candidates WERE found and uniqueness rejected them.

    "the ledger has two plausible entries" sends the agent to disambiguate between known rows;
    "the ledger has nothing" sends it to look for a missing posting. Collapsing both to a bare None
    forces the agent to rediscover which case it is in.
    """
    rows = [_row("GL-1", "2052425.70"), _row("GL-2", "400000.00")]
    got = gl_lookup(ITEM, invoker=_FakeInvoker(rows))
    assert got.row is None and got.reason == GL_AMBIGUOUS


def test_no_matching_row_reports_zero():
    got = gl_lookup(ITEM, invoker=_FakeInvoker([]))
    assert got.row is None and got.reason == GL_ZERO


def test_missing_borrower_reports_no_borrower():
    item = _item()
    item.attributes["idp_attributes"].pop("BorrowerName")
    got = gl_lookup(item, invoker=_FakeInvoker([_row("GL-1", "2052425.70")]))
    assert got.reason == GL_NO_BORROWER


def test_underivable_entry_type_reports_no_entry_type():
    """A missing borrower and an unmapped document class are separate upstream problems.

    They shared one exit before, so the pair also pins that the borrower check runs first.
    """
    item = _item(idp_class="SomethingElse")
    got = gl_lookup(item, invoker=_FakeInvoker([_row("GL-1", "2052425.70")]))
    assert got.reason == GL_NO_ENTRY_TYPE


def test_invoker_failure_reports_query_failed_without_raising():
    def boom(_payload):
        raise RuntimeError("lambda unavailable")

    got = gl_lookup(ITEM, invoker=boom)
    assert got.row is None and got.reason == GL_QUERY_FAILED


def test_gl_lookup_records_which_extracted_amount_the_row_settled():
    """The matched row alone cannot explain the match.

    A document yields several candidate amounts and the row does not know which one it was compared
    against, so the pairing has to be recorded at the moment the comparison is made or it is gone.
    """
    fake = _FakeInvoker([_row("GL-1", "2052425.70")])
    match = gl_lookup(ITEM, invoker=fake).match
    assert match is not None
    assert match["extracted_amount"] == "2052425.7"
    assert match["ledger_amount"] == "2052425.7"
    assert match["entry_type"] == "CREDIT"
    assert match["borrower"] == "CASCADE LOGISTICS HOLDINGS INC."
    assert match["tolerance"] == "0.05"
    assert float(match["difference"]) == 0.0


def test_gl_lookup_reports_the_margin_when_the_amounts_differ_within_tolerance():
    """A near-miss inside tolerance is still a match, and the margin is the interesting part."""
    fake = _FakeInvoker([_row("GL-1", "2052425.73")])
    match = gl_lookup(ITEM, invoker=fake).match
    assert match is not None
    assert round(float(match["difference"]), 4) == 0.03


def test_gl_lookup_reports_how_much_it_had_to_choose_between():
    """How many candidates and rows were in play is what distinguishes a lucky match from a firm one."""
    fake = _FakeInvoker([_row("GL-1", "2052425.70"), _row("GL-2", "12.00")])
    match = gl_lookup(ITEM, invoker=fake).match
    assert match is not None
    assert match["ledger_rows_returned"] == "2"
    assert int(match["candidates_considered"]) >= 2


def test_every_refuted_lookup_carries_no_match_evidence():
    """``match`` is present only alongside a row, never alongside a reason."""
    refuted = [
        gl_lookup(ITEM, invoker=_FakeInvoker([])),
        gl_lookup(ITEM, invoker=_FakeInvoker([_row("GL-9", "999.99")])),
        gl_lookup(ITEM, invoker=_FakeInvoker([_row("GL-1", "2052425.70", entry_type="DEBIT")])),
        gl_lookup(
            ITEM,
            invoker=_FakeInvoker([_row("GL-1", "2052425.70"), _row("GL-2", "400000.00")]),
        ),
        gl_lookup(_item(idp_class=None), invoker=_FakeInvoker([_row("GL-1", "2052425.70")])),
    ]
    for outcome in refuted:
        assert outcome.row is None
        assert outcome.match is None
        assert outcome.reason is not None
